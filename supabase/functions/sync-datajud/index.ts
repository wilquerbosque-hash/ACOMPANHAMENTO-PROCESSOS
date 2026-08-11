// Edge Function: admin-usuarios
// Roda com a service_role key (nunca exposta ao navegador) para poder criar
// contas, redefinir senhas, ativar/desativar, alterar permissões e excluir
// usuários no Supabase Auth.
//
// RESTRIÇÃO ESPECIAL: mesmo que alguém tenha is_admin=true na tabela
// usuarios_perfil (permissão usada em outras partes do sistema, como editar
// processo ou percentuais de provisionamento), a gestão de USUÁRIOS em si só
// funciona para o e-mail configurado em SUPER_ADMIN_EMAIL — a pedido
// explícito de que só um login tenha esse poder específico.
//
// Deploy: supabase functions deploy admin-usuarios
// Variáveis de ambiente necessárias (Project Settings > Edge Functions > Secrets):
//   SUPABASE_URL              (já vem pronta por padrão)
//   SUPABASE_SERVICE_ROLE_KEY (Project Settings > API > service_role — NUNCA no front-end)
//   SUPER_ADMIN_EMAIL         (o e-mail de login autorizado a gerenciar usuários)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const SUPER_ADMIN_EMAIL = (Deno.env.get("SUPER_ADMIN_EMAIL") || "").toLowerCase().trim();

function gerarSenhaProvisoria() {
  return "Konsi@" + Math.random().toString(36).slice(-8);
}

function json(obj, status, corsHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!jwt) return json({ error: "Não autenticado." }, 401, corsHeaders);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Identifica quem está chamando
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "Sessão inválida." }, 401, corsHeaders);

    // Só o e-mail configurado como super admin pode gerenciar usuários —
    // independente do valor de is_admin na tabela (esse flag continua
    // controlando outras permissões do sistema, mas não esta).
    const emailSolicitante = (userData.user.email || "").toLowerCase().trim();
    if (!SUPER_ADMIN_EMAIL) {
      return json({ error: "SUPER_ADMIN_EMAIL não configurado nos secrets da função. Configure antes de usar esta tela." }, 500, corsHeaders);
    }
    if (emailSolicitante !== SUPER_ADMIN_EMAIL) {
      return json({ error: "Só o administrador principal do sistema pode gerenciar usuários." }, 403, corsHeaders);
    }

    const body = await req.json();
    const { action } = body;

    if (action === "listar") {
      const { data: authUsers, error } = await admin.auth.admin.listUsers();
      if (error) throw error;
      const { data: perfis } = await admin.from("usuarios_perfil").select("*");
      const perfilPorId = Object.fromEntries((perfis || []).map((p) => [p.id, p]));
      const lista = authUsers.users.map((u) => ({
        id: u.id,
        email: u.email,
        banido: !!u.banned_until && new Date(u.banned_until) > new Date(),
        nome_exibicao: perfilPorId[u.id]?.nome_exibicao || "(sem nome cadastrado)",
        is_admin: perfilPorId[u.id]?.is_admin || false,
        ativo: perfilPorId[u.id]?.ativo ?? true,
      }));
      return json({ usuarios: lista }, 200, corsHeaders);
    }

    if (action === "criar") {
      const { email, nome_exibicao, is_admin } = body;
      if (!email || !nome_exibicao) return json({ error: "E-mail e nome são obrigatórios." }, 400, corsHeaders);
      const senhaProvisoria = gerarSenhaProvisoria();
      const { data: novoUsuario, error } = await admin.auth.admin.createUser({
        email, password: senhaProvisoria, email_confirm: true,
      });
      if (error) throw error;
      await admin.from("usuarios_perfil").insert({
        id: novoUsuario.user.id, nome_exibicao, is_admin: !!is_admin,
      });
      return json({ ok: true, senha_provisoria: senhaProvisoria }, 200, corsHeaders);
    }

    if (action === "redefinir_senha") {
      const { user_id } = body;
      const novaSenha = gerarSenhaProvisoria();
      const { error } = await admin.auth.admin.updateUserById(user_id, { password: novaSenha });
      if (error) throw error;
      return json({ ok: true, nova_senha: novaSenha }, 200, corsHeaders);
    }

    if (action === "alterar_status") {
      const { user_id, ativo } = body;
      const { error } = await admin.auth.admin.updateUserById(user_id, {
        ban_duration: ativo ? "none" : "876000h",
      });
      if (error) throw error;
      await admin.from("usuarios_perfil").update({ ativo }).eq("id", user_id);
      return json({ ok: true }, 200, corsHeaders);
    }

    // NOVO: alterar se um usuário é administrador (is_admin) — essa é a
    // única forma de mudar isso, já que o front-end nunca escreve
    // diretamente nessa coluna (gatilho fn_protege_is_admin bloqueia).
    if (action === "editar_permissoes") {
      const { user_id, is_admin } = body;
      if (user_id === userData.user.id && !is_admin) {
        return json({ error: "Você não pode remover sua própria permissão de administrador por aqui." }, 400, corsHeaders);
      }
      const { error } = await admin.from("usuarios_perfil").update({ is_admin: !!is_admin }).eq("id", user_id);
      if (error) throw error;
      return json({ ok: true }, 200, corsHeaders);
    }

    // NOVO: excluir usuário definitivamente. Bloqueia se houver histórico
    // vinculado a ele (processos cadastrados, tarefas, movimentações, etc.)
    // para não quebrar a trilha de auditoria — nesses casos, orienta a usar
    // "Desativar" em vez de excluir.
    if (action === "excluir") {
      const { user_id } = body;
      if (user_id === userData.user.id) {
        return json({ error: "Você não pode excluir a si mesmo." }, 400, corsHeaders);
      }

      const tabelasComReferencia = [
        { tabela: "processos_judiciais", coluna: "responsavel_cadastro" },
        { tabela: "movimentacoes_processo", coluna: "responsavel_id" },
        { tabela: "tarefas_acompanhamento", coluna: "responsavel_id" },
        { tabela: "metricas_mensais", coluna: "atualizado_por" },
        { tabela: "logs_auditoria_processos", coluna: "usuario_id" },
      ];
      for (const { tabela, coluna } of tabelasComReferencia) {
        const { count, error } = await admin.from(tabela).select("id", { count: "exact", head: true }).eq(coluna, user_id);
        if (error) throw error;
        if (count && count > 0) {
          return json({
            error: `Este usuário tem ${count} registro(s) vinculado(s) em "${tabela}" — excluir apagaria parte do histórico. Use "Desativar" em vez de excluir.`,
          }, 400, corsHeaders);
        }
      }

      const { error: errPerfil } = await admin.from("usuarios_perfil").delete().eq("id", user_id);
      if (errPerfil) throw errPerfil;
      const { error: errAuth } = await admin.auth.admin.deleteUser(user_id);
      if (errAuth) throw errAuth;
      return json({ ok: true }, 200, corsHeaders);
    }

    return json({ error: "Ação desconhecida." }, 400, corsHeaders);
  } catch (e) {
    return json({ error: e.message || String(e) }, 500, corsHeaders);
  }
});
