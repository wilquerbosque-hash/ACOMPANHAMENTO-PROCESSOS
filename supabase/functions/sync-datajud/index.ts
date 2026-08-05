// Edge Function: sync-datajud
// É chamada pelo PRÓPRIO index.html quando alguém loga no sistema (não roda
// sozinha em segundo plano por conta própria, não depende de pg_cron). Ao ser
// chamada, ela:
//   1. Verifica em datajud_sync_status se já rodou há pouco tempo; se sim,
//      responde "pulado" na hora e não consulta o DataJud de novo — evita
//      bater na API a cada login, se várias pessoas entrarem no mesmo dia.
//   2. Caso contrário, responde IMEDIATAMENTE "iniciado" pro navegador e
//      continua rodando no servidor do Supabase via EdgeRuntime.waitUntil,
//      mesmo que a pessoa feche a aba ou recarregue a página logo em seguida.
//   3. Em segundo plano: percorre todos os processos com status_processo = 'ATIVO',
//      consulta a API Pública do DataJud (CNJ) pelo número de cada um — trazendo
//      TODO o histórico de movimentações do processo, não só a mais recente —
//      e grava em movimentacoes_processo (origem = 'ROBO_DATAJUD') qualquer
//      movimentação que ainda não estava registrada.
//   4. Se alguma movimentação nova entrou para um processo, cria uma tarefa de
//      acompanhamento "Inspecionar processo X" (origem = 'ROBO_DATAJUD') — o
//      resumo em linguagem simples é escrito manualmente por alguém do time
//      ao revisar o processo, não por IA. Não cria uma tarefa nova se já
//      existir uma aberta esperando revisão para aquele mesmo processo.
//   5. Não envia e-mail/Slack — a novidade aparece no painel "Atualizações
//      recentes" (tela inicial) e como tarefa pendente (aba Acompanhamentos).
//
// MODO "PROCESSO ÚNICO": além do fluxo acima (sincronização geral em lote),
// esta função também aceita ser chamada com { "processo_id": "..." } no
// corpo da requisição — nesse caso, consulta e enriquece só aquele processo
// na hora, de forma síncrona (sem throttle, sem waitUntil). É esse modo que
// o index.html usa logo depois de alguém cadastrar um processo manualmente.
//
// Deploy: supabase functions deploy sync-datajud
// Variáveis de ambiente necessárias (Project Settings > Edge Functions > Secrets):
//   SUPABASE_URL              (já vem pronta por padrão)
//   SUPABASE_SERVICE_ROLE_KEY (Project Settings > API > service_role — NUNCA no front-end)
//   DATAJUD_API_KEY           (ver instruções de obtenção no README)
//
// Quem chama essa função é o navegador de quem acabou de logar, enviando o
// próprio token de sessão (Authorization: Bearer <access_token>). Como o
// Supabase já valida esse JWT antes de deixar a requisição chegar aqui
// (comportamento padrão de toda Edge Function), só usuário autenticado do
// sistema consegue disparar a sincronização — não precisa checar isso de novo
// dentro do código.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const DATAJUD_API_KEY = Deno.env.get("DATAJUD_API_KEY");
const DATAJUD_BASE_URL = "https://api-publica.datajud.cnj.jus.br";

// Intervalo mínimo entre duas execuções reais do robô, mesmo que várias
// pessoas logem nesse meio tempo. Ajuste livremente (em minutos).
const MINUTOS_MINIMOS_ENTRE_EXECUCOES = 240; // 4 horas

// Prazo (em dias, a partir de hoje) dado à tarefa automática de inspeção
// criada quando o robô encontra movimentação nova. Ajuste livremente.
const PRAZO_DIAS_TAREFA_INSPECAO = 3;

// Movimentações com data ANTERIOR a esta data são gravadas normalmente no
// histórico (pra você poder ver todo o histórico do processo), mas NÃO geram
// tarefa de inspeção — isso evita que a primeira sincronização completa (que
// traz anos de histórico de uma vez) crie uma enxurrada de tarefas de uma vez
// só. Só movimentações a partir desta data passam a gerar tarefa. Ajuste ou
// remova (deixe null) conforme a necessidade.
const DATA_CORTE_TAREFA_INSPECAO = "2026-07-01";

// Converte o valor salvo no campo "tribunal" (ex: TJBA, TRF1, TRT5) no alias
// usado pela URL da API do DataJud (ex: tjba, trf1, trt5).
// Cobre os padrões mais comuns; tribunais com sigla irregular podem precisar
// de um ajuste manual aqui (ex: mapa fixo) se o alias automático não bater.
function tribunalParaAlias(tribunal: string): string | null {
  if (!tribunal) return null;
  return tribunal.trim().toLowerCase().replace(/\s+/g, "");
}

// O DataJud indexa o número do processo apenas com dígitos (sem os
// separadores do formato CNJ NNNNNNN-DD.AAAA.J.TR.OOOO).
function apenasDigitos(numero: string): string {
  return (numero || "").replace(/\D/g, "");
}

async function consultarDatajud(tribunal: string, numeroProcesso: string) {
  const alias = tribunalParaAlias(tribunal);
  if (!alias) return { erro: "Tribunal não informado no cadastro do processo." };

  const url = `${DATAJUD_BASE_URL}/api_publica_${alias}/_search`;
  const body = {
    query: { match: { numeroProcesso: apenasDigitos(numeroProcesso) } },
    size: 1,
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `APIKey ${DATAJUD_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    return { erro: `DataJud retornou ${resp.status} para o alias "${alias}".` };
  }

  const data = await resp.json();
  const hit = data?.hits?.hits?.[0]?._source;
  if (!hit) return { erro: "Processo não localizado no DataJud (pode ser sigiloso ou não indexado ainda)." };

  // Traz TODO o histórico de movimentações do processo (a API não limita isso
  // a "a mais recente" — quem decidia pegar só uma era o código antigo daqui).
  // Ordenado da mais antiga pra mais nova, pra inserir no histórico na ordem certa.
  const movimentos = (hit.movimentos || [])
    .slice()
    .sort((a: any, b: any) => new Date(a.dataHora).getTime() - new Date(b.dataHora).getTime());

  // Metadados da "capa processual" (tudo que não é movimentação). Os nomes
  // exatos de alguns campos podem variar um pouco entre tribunais/versões da
  // API — por isso guardamos o "hit" bruto inteiro em datajud_metadados
  // também, pra dar pra conferir/ajustar sem depender só deste mapeamento.
  const capa = {
    classe: hit.classe?.nome || null,
    assuntos: (hit.assuntos || []).map((a: any) => a?.nome).filter(Boolean),
    orgaoJulgador: hit.orgaoJulgador?.nome || null,
    grau: hit.grau || hit.instancia || null,
    nivelSigilo: typeof hit.nivelSigilo === "number"
      ? (hit.nivelSigilo === 0 ? "PUBLICO" : `NIVEL_${hit.nivelSigilo}`)
      : (hit.nivelSigilo || null),
    valorCausa: hit.valorCausa ?? null,
    justicaGratuita: hit.justicaGratuita ?? null,
    liminar: hit.liminar ?? null,
    dataAjuizamento: (hit.dataAjuizamento || "").slice(0, 10) || null,
    bruto: hit,
  };

  return { movimentos, capa };
}

// Cria a tarefa "Inspecionar processo X" quando o robô encontra movimentação
// nova, MAS só se ainda não existir uma tarefa aberta (pendente/atrasada)
// desse mesmo tipo esperando revisão para esse processo — evita empilhar
// uma tarefa nova a cada execução enquanto ninguém tiver revisado a anterior.
async function criarTarefaInspecao(admin: ReturnType<typeof createClient>, processo: { id: string; numero_processo: string }) {
  const { data: tarefaAberta } = await admin
    .from("tarefas_acompanhamento")
    .select("id")
    .eq("processo_id", processo.id)
    .eq("origem", "ROBO_DATAJUD")
    .in("status", ["PENDENTE", "ATRASADA"])
    .limit(1)
    .maybeSingle();

  if (tarefaAberta) return false; // já tem uma tarefa esperando revisão, não duplica

  const prazo = new Date();
  prazo.setDate(prazo.getDate() + PRAZO_DIAS_TAREFA_INSPECAO);

  const { error } = await admin.from("tarefas_acompanhamento").insert({
    processo_id: processo.id,
    titulo: `Inspecionar processo ${processo.numero_processo} — nova movimentação identificada (DataJud)`,
    data_prazo: prazo.toISOString().slice(0, 10),
    origem: "ROBO_DATAJUD",
    observacao: "Criada automaticamente: o robô do DataJud identificou movimentação nova neste processo. Abra os autos e, se fizer sentido, atualize o campo \"Resumo da situação\" do processo.",
  });

  return !error;
}

// Processa UM processo: consulta o DataJud, grava movimentações novas, cria
// tarefa de inspeção se for o caso, e atualiza os metadados da capa. Usada
// tanto pelo lote da sincronização geral quanto pelo modo "processo único"
// (disparado na hora, quando alguém cadastra um processo manualmente).
async function processarUmProcesso(
  admin: ReturnType<typeof createClient>,
  processo: { id: string; numero_processo: string; tribunal: string; situacao_atual: string; classificacao_risco: string; data_ajuizamento?: string | null },
) {
  const consulta = await consultarDatajud(processo.tribunal, processo.numero_processo);
  const erros: any[] = [];

  if (consulta.erro) {
    await admin
      .from("processos_judiciais")
      .update({ datajud_ultima_consulta: new Date().toISOString(), datajud_ultimo_erro: consulta.erro })
      .eq("id", processo.id);
    return { erro: consulta.erro, novas_movimentacoes: 0, tarefa_criada: false, erros };
  }

  // Tenta inserir CADA movimentação vinda do DataJud (não só a mais recente).
  // O índice único (processo_id + codigo_movimento_datajud + data_movimentacao)
  // faz o banco recusar sozinho o que já estava registrado — por isso inserimos
  // uma a uma e simplesmente ignoramos o erro de duplicidade (código 23505).
  let novasNesteProcesso = 0;
  let novasAposCorteNesteProcesso = 0;
  for (const mov of consulta.movimentos || []) {
    const codigo = String(mov.codigo ?? mov.nome ?? "");
    const dataMovimentacao = (mov.dataHora || "").slice(0, 10); // yyyy-mm-dd
    if (!dataMovimentacao) continue;

    const { error: erroInsert } = await admin.from("movimentacoes_processo").insert({
      processo_id: processo.id,
      data_movimentacao: dataMovimentacao,
      descricao: mov.nome || "Movimentação identificada via DataJud",
      risco_no_momento: processo.classificacao_risco,
      situacao_no_momento: processo.situacao_atual,
      origem: "ROBO_DATAJUD",
      codigo_movimento_datajud: codigo,
    });

    if (!erroInsert) {
      novasNesteProcesso++;
      // Só conta pra fins de "gerar tarefa" se a movimentação for recente
      // (ver DATA_CORTE_TAREFA_INSPECAO) — movimentação antiga entra no
      // histórico normalmente, mas não dispara tarefa de inspeção.
      if (!DATA_CORTE_TAREFA_INSPECAO || dataMovimentacao >= DATA_CORTE_TAREFA_INSPECAO) {
        novasAposCorteNesteProcesso++;
      }
    } else if (erroInsert.code !== "23505") {
      // 23505 = violação de índice único = já existia, ignora silenciosamente.
      erros.push(`Falha ao gravar movimentação: ${erroInsert.message}`);
    }
  }

  // Só cria a tarefa de inspeção se entrou movimentação nova E recente o
  // suficiente (ver DATA_CORTE_TAREFA_INSPECAO) — não fica agendando
  // revisão pra movimentação antiga vinda do backlog histórico. No cadastro
  // manual isso raramente vai acontecer (processo novo, sem histórico
  // recente ainda), mas mantém a mesma regra por consistência.
  let tarefaCriada = false;
  if (novasAposCorteNesteProcesso > 0) {
    tarefaCriada = await criarTarefaInspecao(admin, processo);
  }

  await admin
    .from("processos_judiciais")
    .update(montarPayloadMetadados(processo, consulta.capa))
    .eq("id", processo.id);

  return { erro: null, novas_movimentacoes: novasNesteProcesso, tarefa_criada: tarefaCriada, erros };
}
// Usa "??" de propósito: se a capa não trouxer um campo (undefined ou null),
// o campo correspondente fica de fora do payload e o valor já salvo no banco
// não é apagado — só atualizamos quando o DataJud realmente informa algo.
function montarPayloadMetadados(processo: { data_ajuizamento?: string | null }, capa?: any) {
  const payload: Record<string, unknown> = {
    datajud_ultima_consulta: new Date().toISOString(),
    datajud_ultimo_erro: null,
    classe_processual: capa?.classe ?? undefined,
    assunto_principal: capa?.assuntos?.length ? capa.assuntos.join("; ") : undefined,
    orgao_julgador: capa?.orgaoJulgador ?? undefined,
    grau_instancia: capa?.grau ?? undefined,
    nivel_sigilo: capa?.nivelSigilo ?? undefined,
    valor_causa: capa?.valorCausa ?? undefined,
    justica_gratuita: capa?.justicaGratuita ?? undefined,
    liminar: capa?.liminar ?? undefined,
    datajud_metadados: capa?.bruto ?? undefined,
  };
  // Só preenche data_ajuizamento se o processo ainda não tinha essa data
  // cadastrada — nunca sobrescreve o que já foi preenchido manualmente.
  if (!processo.data_ajuizamento && capa?.dataAjuizamento) {
    payload.data_ajuizamento = capa.dataAjuizamento;
  }
  return payload;
}

// O plano Free do Supabase mata a execução (mesmo em segundo plano) depois de
// 150 segundos no total — por isso NÃO dá pra consultar todos os processos de
// uma vez, um por um. A solução: cada execução processa só um LOTE, com várias
// consultas ao DataJud em paralelo (CONCORRENCIA), e sempre prioriza os
// processos que fazem mais tempo que não são verificados (ou nunca foram).
// Com logins ao longo do dia, todos os processos acabam sendo cobertos aos
// poucos. Se estiver no plano Pro, pode aumentar TAMANHO_LOTE_POR_EXECUCAO
// (o limite lá é 400s em vez de 150s).
const TAMANHO_LOTE_POR_EXECUCAO = 40;
const CONCORRENCIA = 5;

// Roda fn() sobre os itens com no máximo "concorrencia" execuções simultâneas
// — em vez de uma consulta ao DataJud de cada vez (lento) ou todas de uma vez
// (arriscado de sobrecarregar/tomar rate limit), faz um meio-termo controlado.
async function mapComConcorrencia<T>(items: T[], concorrencia: number, fn: (item: T) => Promise<void>) {
  const fila = [...items];
  const trabalhadores = Array.from({ length: Math.min(concorrencia, items.length) }, async () => {
    while (fila.length) {
      const item = fila.shift();
      if (item === undefined) break;
      await fn(item);
    }
  });
  await Promise.all(trabalhadores);
}

async function executarSincronizacao(admin: ReturnType<typeof createClient>) {
  const { count: totalAtivos } = await admin
    .from("processos_judiciais")
    .select("id", { count: "exact", head: true })
    .eq("status_processo", "ATIVO");

  // Prioriza quem nunca foi consultado (null vem primeiro) e depois quem faz
  // mais tempo que não é verificado — assim o robô vai rotacionando sozinho
  // por todos os processos ativos ao longo de vários logins.
  const { data: processos, error: erroProcessos } = await admin
    .from("processos_judiciais")
    .select("id, numero_processo, tribunal, situacao_atual, classificacao_risco, data_ajuizamento")
    .eq("status_processo", "ATIVO")
    .order("datajud_ultima_consulta", { ascending: true, nullsFirst: true })
    .limit(TAMANHO_LOTE_POR_EXECUCAO);

  if (erroProcessos) {
    await admin.from("datajud_sync_status").update({
      ultima_execucao_resumo: { erro_geral: erroProcessos.message },
    }).eq("id", 1);
    return;
  }

  const resultado = {
    verificados: 0,
    total_ativos: totalAtivos ?? null,
    tamanho_lote: TAMANHO_LOTE_POR_EXECUCAO,
    novas_movimentacoes: 0,
    tarefas_criadas: 0,
    erros: [] as any[],
  };

  for (const processo of processos || []) {
    resultado.verificados++;
    const resultadoProcesso = await processarUmProcesso(admin, processo);

    if (resultadoProcesso.erro) {
      resultado.erros.push({ processo: processo.numero_processo, erro: resultadoProcesso.erro });
      continue;
    }
    resultado.novas_movimentacoes += resultadoProcesso.novas_movimentacoes;
    if (resultadoProcesso.tarefa_criada) resultado.tarefas_criadas++;
    resultadoProcesso.erros.forEach((erro: string) =>
      resultado.erros.push({ processo: processo.numero_processo, erro }));
  }

  // Só grava o resumo ao final — é essa gravação que sumia quando a conexão
  // com o navegador era cortada no meio da execução (ver EdgeRuntime.waitUntil
  // abaixo, que resolve isso desacoplando a execução do navegador).
  await admin.from("datajud_sync_status").update({ ultima_execucao_resumo: resultado }).eq("id", 1);
}

Deno.serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // MODO "PROCESSO ÚNICO": usado pelo cadastro manual de processo, pra
    // preencher os dados do DataJud na hora, assim que o processo é salvo.
    // Não passa pelo throttle geral (é uma ação pontual do usuário, não o
    // robô rodando sozinho) e responde de forma síncrona (só 1 consulta
    // externa, rápido o suficiente pra não precisar de EdgeRuntime.waitUntil).
    let processoId: string | undefined;
    try {
      const body = await req.json();
      processoId = body?.processo_id;
    } catch {
      // corpo vazio/ausente = segue pro modo de sincronização geral
    }

    if (processoId) {
      const { data: processo, error: erroBusca } = await admin
        .from("processos_judiciais")
        .select("id, numero_processo, tribunal, situacao_atual, classificacao_risco, data_ajuizamento")
        .eq("id", processoId)
        .single();

      if (erroBusca || !processo) {
        return new Response(JSON.stringify({ error: "Processo não encontrado." }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const resultado = await processarUmProcesso(admin, processo);
      return new Response(JSON.stringify(resultado), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Throttle: se já rodou há menos de MINUTOS_MINIMOS_ENTRE_EXECUCOES, não
    // consulta o DataJud de novo — só informa que pulou por ter sido recente.
    const { data: status } = await admin
      .from("datajud_sync_status")
      .select("ultima_execucao")
      .eq("id", 1)
      .single();

    if (status?.ultima_execucao) {
      const minutosDesdeUltima = (Date.now() - new Date(status.ultima_execucao).getTime()) / 60000;
      if (minutosDesdeUltima < MINUTOS_MINIMOS_ENTRE_EXECUCOES) {
        return new Response(
          JSON.stringify({ pulado: true, motivo: "Sincronizado recentemente.", minutos_desde_ultima: Math.round(minutosDesdeUltima) }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // Marca a execução como "em andamento" já de cara, pra evitar que dois
    // logins quase simultâneos disparem duas consultas completas em paralelo.
    await admin.from("datajud_sync_status").update({ ultima_execucao: new Date().toISOString() }).eq("id", 1);

    // IMPORTANTE: a sincronização continua rodando no servidor do Supabase
    // mesmo que o navegador de quem logou seja fechado ou a página seja
    // recarregada logo em seguida. EdgeRuntime.waitUntil() é o mecanismo do
    // Supabase/Deno pra isso — sem ele, fechar a aba cedo demais interrompe
    // a execução no meio (foi o que causou o "EarlyDrop" visto nos logs).
    // @ts-ignore — EdgeRuntime é um global específico do ambiente Supabase/Deno Deploy
    EdgeRuntime.waitUntil(executarSincronizacao(admin));

    return new Response(
      JSON.stringify({ iniciado: true, motivo: "Sincronização iniciada em segundo plano no servidor." }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
