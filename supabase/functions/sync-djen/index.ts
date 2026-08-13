// Edge Function: sync-djen
// Consulta o DJEN (Diário de Justiça Eletrônico Nacional) por número de
// processo e grava as comunicações encontradas (intimações, decisões) —
// complementando o que o DataJud já traz.
//
// IMPORTANTE: diferente da API pública do DataJud, essa consulta ao DJEN
// (comunicaapi.pje.jus.br) não tem termo de uso nem chave formalizados pra
// terceiros — é o mesmo backend que o site público usa. Por isso essa
// função é separada da sync-datajud: se o DJEN mudar de formato ou ficar
// fora do ar, isso não afeta a sincronização que já funciona bem hoje.
//
// Deploy: supabase/functions/sync-djen/index.ts

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const DJEN_BASE_URL = "https://comunicaapi.pje.jus.br/api/v1/comunicacao";

const THROTTLE_MINUTOS = 240; // mesmo intervalo do DataJud
const TAMANHO_LOTE_POR_EXECUCAO = 20; // função separada, lote próprio e mais conservador
// Mesma data de corte usada na sync-datajud — mantenha os dois valores
// iguais manualmente se um dia precisar mudar (são funções independentes).
const DATA_CORTE_TAREFA_INSPECAO = "2026-08-05";

// Processos nessas situações são exatamente onde o texto do DJEN mais
// importa — é onde o "dispositivo" da decisão mora. Esses entram primeiro
// na fila de cada execução, antes dos demais processos ativos.
const SITUACOES_PRIORITARIAS = [
  "AGUARDANDO SENTENÇA",
  "AGUARDANDO JULGAMENTO",
  "RECURSO INTERPOSTO - AGUARDANDO JULGAMENTO",
  "EMBARGOS DE DECLARAÇÃO OPOSTOS - AGUARDANDO JULGAMENTO",
];

function apenasDigitos(numero: string): string {
  return (numero || "").replace(/\D/g, "");
}

// Remove acentos e baixa a caixa, pra comparação de texto tolerante.
function normalizarTexto(s: string): string {
  return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// Busca palavras-chave do dispositivo da decisão. A ORDEM dos "if" importa:
// checa as combinações mais específicas primeiro (ex: "parcialmente
// procedente" e "improcedente" antes de "procedente" sozinho), porque
// "improcedente" contém a palavra "procedente" dentro dela — se checasse
// "procedente" primeiro, ia errar toda sentença improcedente.
// Isso é só uma SUGESTÃO pra revisão humana — nunca aplicada sozinha.
function detectarResultadoNoTexto(textoOriginal: string): string | null {
  const t = normalizarTexto(textoOriginal);

  if (t.includes("embargos de declaracao")) {
    if (t.includes("nao acolh") || t.includes("rejeit")) return "EMBARGOS DE DECLARAÇÃO REJEITADOS";
    if (t.includes("acolh")) return "EMBARGOS DE DECLARAÇÃO ACOLHIDOS";
  }
  if (t.includes("parcialmente provido")) return "RECURSO PARCIALMENTE PROVIDO";
  if (t.includes("nao provido") || t.includes("improvido")) return "RECURSO IMPROVIDO";
  if (t.includes("recurso") && t.includes("provido")) return "RECURSO PROVIDO";

  if (t.includes("parcialmente procedente") || t.includes("procedente em parte")) return "SENTENÇA PARCIALMENTE PROCEDENTE";
  if (t.includes("improcedente")) return "SENTENÇA IMPROCEDENTE";
  if (t.includes("procedente")) return "SENTENÇA PROCEDENTE";

  return null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function consultarDjen(numeroProcesso: string, tentativa = 1): Promise<any> {
  const url = `${DJEN_BASE_URL}?numeroProcesso=${apenasDigitos(numeroProcesso)}`;
  try {
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    if (!resp.ok) {
      if (tentativa < 2) { await sleep(1500); return consultarDjen(numeroProcesso, tentativa + 1); }
      return { erro: `DJEN retornou ${resp.status}.` };
    }
    const data = await resp.json();
    return { items: data.items || [] };
  } catch (e) {
    return { erro: `Falha ao consultar DJEN: ${e.message}` };
  }
}

async function processarUmProcessoDjen(admin: any, processo: any) {
  const resultado = await consultarDjen(processo.numero_processo);
  if (resultado.erro) return { erro: resultado.erro, novas: 0 };

  const itens = resultado.items || [];
  if (!itens.length) return { erro: null, novas: 0 };

  let novas = 0;
  let maisRecente: any = null;
  let melhorSugestao: string | null = null;

  for (const item of itens) {
    const sugestao = detectarResultadoNoTexto(item.texto);
    const { error } = await admin.from("comunicacoes_djen").insert({
      processo_id: processo.id,
      comunicacao_id_externa: item.id,
      numero_comunicacao: item.numeroComunicacao ?? null,
      tipo_comunicacao: item.tipoComunicacao ?? null,
      tipo_documento: item.tipoDocumento ?? null,
      nome_orgao: item.nomeOrgao ?? null,
      nome_classe: item.nomeClasse ?? null,
      data_disponibilizacao: item.data_disponibilizacao ?? item.datadisponibilizacao ?? null,
      texto: item.texto ?? null,
      link: item.link ?? null,
      meio_completo: item.meiocompleto ?? null,
      destinatarios: item.destinatarios ?? null,
      resultado_sugerido: sugestao,
    });
    if (!error) novas++;
    if (!maisRecente || (item.data_disponibilizacao > maisRecente.data_disponibilizacao)) maisRecente = item;
    if (sugestao) melhorSugestao = sugestao; // fica com a última encontrada, tipicamente a mais recente também
  }

  // Preenche campos da capa processual só se o DataJud não tiver preenchido
  // (nunca sobrescreve um dado que já existe vindo de outra fonte).
  const camposFaltando: Record<string, any> = {};
  if (!processo.classe_processual && maisRecente?.nomeClasse) camposFaltando.classe_processual = maisRecente.nomeClasse;
  if (!processo.orgao_julgador && maisRecente?.nomeOrgao) camposFaltando.orgao_julgador = maisRecente.nomeOrgao;
  if (Object.keys(camposFaltando).length) {
    await admin.from("processos_judiciais").update(camposFaltando).eq("id", processo.id);
  }

  // Cria tarefa de inspeção se alguma comunicação for recente e ainda não
  // houver uma tarefa aberta de origem robô pra esse processo (mesma lógica
  // já usada na sync-datajud).
  if (maisRecente?.data_disponibilizacao >= DATA_CORTE_TAREFA_INSPECAO) {
    const { data: tarefaAberta } = await admin.from("tarefas_acompanhamento")
      .select("id").eq("processo_id", processo.id).eq("origem", "ROBO_DATAJUD")
      .in("status", ["PENDENTE", "ATRASADA"]).limit(1);
    if (!tarefaAberta?.length) {
      const titulo = melhorSugestao
        ? `Possível resultado identificado no DJEN: ${melhorSugestao} — confirmar e atualizar Situação Atual`
        : `Nova comunicação no DJEN: ${maisRecente.tipoComunicacao || "publicação"}`;
      await admin.from("tarefas_acompanhamento").insert({
        processo_id: processo.id,
        titulo,
        data_prazo: new Date().toISOString().slice(0, 10),
        status: "PENDENTE",
        origem: "ROBO_DATAJUD",
      });
    }
  }

  return { erro: null, novas };
}

Deno.serve(async (req) => {
  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: status } = await admin.from("djen_sync_status").select("*").eq("id", 1).single();
    const agora = new Date();
    if (status?.ultima_execucao) {
      const minutosDesdeUltima = (agora.getTime() - new Date(status.ultima_execucao).getTime()) / 60000;
      if (minutosDesdeUltima < THROTTLE_MINUTOS) {
        return new Response(JSON.stringify({ pulado: true, motivo: "throttle" }), { status: 200 });
      }
    }
    await admin.from("djen_sync_status").update({ ultima_execucao: agora.toISOString() }).eq("id", 1);

    const colunasBusca = "id, numero_processo, classe_processual, orgao_julgador";

    const { data: prioritarios, count: totalAtivos } = await admin
      .from("processos_judiciais")
      .select(colunasBusca, { count: "exact" })
      .eq("status_processo", "ATIVO")
      .in("situacao_atual", SITUACOES_PRIORITARIAS)
      .order("datajud_ultima_consulta", { ascending: true, nullsFirst: true })
      .limit(TAMANHO_LOTE_POR_EXECUCAO);

    let processos = prioritarios || [];
    if (processos.length < TAMANHO_LOTE_POR_EXECUCAO) {
      const idsJaPegos = processos.map((p: any) => p.id);
      let query = admin.from("processos_judiciais")
        .select(colunasBusca)
        .eq("status_processo", "ATIVO")
        .not("situacao_atual", "in", `(${SITUACOES_PRIORITARIAS.map((s) => `"${s}"`).join(",")})`)
        .order("datajud_ultima_consulta", { ascending: true, nullsFirst: true })
        .limit(TAMANHO_LOTE_POR_EXECUCAO - processos.length);
      if (idsJaPegos.length) query = query.not("id", "in", `(${idsJaPegos.join(",")})`);
      const { data: restante } = await query;
      processos = processos.concat(restante || []);
    }

    const resultado = {
      verificados: 0, tamanho_lote: TAMANHO_LOTE_POR_EXECUCAO,
      total_ativos: totalAtivos ?? null, novas_comunicacoes: 0, erros: [] as any[],
    };

    for (const processo of processos || []) {
      resultado.verificados++;
      const r = await processarUmProcessoDjen(admin, processo);
      await sleep(300);
      if (r.erro) resultado.erros.push({ processo: processo.numero_processo, erro: r.erro });
      resultado.novas_comunicacoes += r.novas;
    }

    await admin.from("djen_sync_status").update({ ultima_execucao_resumo: resultado }).eq("id", 1);
    return new Response(JSON.stringify(resultado), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
});
