import { z } from "zod";
import { resolveSeller } from "./resolveSeller.js";
import { ok, errorResult, toErrorResult, type ToolDefinition } from "./types.js";
import { getItem } from "../mercadolivre/endpoints.js";
import { mlPut } from "../mercadolivre/client.js";
import { uploadPicture } from "../mercadolivre/extraEndpoints.js";

/**
 * Gerencia as fotos de um anúncio: adicionar, substituir todas, remover ou
 * reordenar. Aceita imagens por link público (a ML baixa sozinha — ex.: fotos
 * do site da loja/Shoppub) ou em base64 (sobe para a ML antes).
 *
 * Fluxo de segurança igual ao editar_anuncio: sem `confirmar=true` só mostra a
 * prévia (fotos atuais -> fotos novas); com `confirmar=true` aplica.
 */

const imagemSchema = z
  .object({
    url: z.string().url().optional().describe("Link público da imagem (JPG/PNG). A ML baixa direto do link."),
    base64: z.string().optional().describe("Imagem em base64 ou data URL (data:image/jpeg;base64,...)"),
    nome: z.string().optional().describe("Nome do arquivo, só para referência"),
  })
  .refine((x) => !!x.url || !!x.base64, { message: "Informe url ou base64" });

const schema = {
  seller: z.string().describe("Nome interno do seller"),
  mlb: z.string().describe("ID do anúncio, ex.: MLB1234567890"),
  acao: z
    .enum(["adicionar", "substituir", "remover", "reordenar"])
    .describe(
      "adicionar = inclui as novas no fim (ou na posição 'posicao'); substituir = troca TODAS as fotos pelas novas; remover = tira as fotos de 'remover_ids'; reordenar = aplica a ordem de 'ordem_ids'"
    ),
  imagens: z.array(imagemSchema).max(12).optional().describe("Novas imagens (para adicionar/substituir). A primeira vira capa em 'substituir'."),
  posicao: z.number().int().min(1).optional().describe("Em 'adicionar': posição (1 = capa) onde entram as novas. Default: no fim."),
  remover_ids: z.array(z.string()).optional().describe("IDs das fotos a remover (ver prévia)"),
  ordem_ids: z.array(z.string()).optional().describe("Nova ordem completa dos IDs das fotos atuais"),
  confirmar: z.boolean().optional().describe("true aplica; sem isso só mostra a prévia"),
};

type Pic = { id?: string; source?: string };

export const atualizarImagensAnuncioTool: ToolDefinition<typeof schema> = {
  name: "atualizar_imagens_anuncio",
  title: "Atualizar imagens do anúncio",
  description:
    "Adiciona, substitui, remove ou reordena as fotos de um anúncio do Mercado Livre, por link público (ex.: fotos do site) ou base64. " +
    "Mostra a prévia (fotos atuais e como ficará) e só aplica com confirmar=true. Regras da ML: capa com fundo branco e sem texto; mínimo recomendado 3 fotos; até 12; 1200x1200 px ou mais.",
  inputSchema: schema,
  handler: async ({ seller, mlb, acao, imagens, posicao, remover_ids, ordem_ids, confirmar }) => {
    try {
      resolveSeller(seller);
      const item = await getItem(seller, mlb);
      const atuais = item.pictures ?? [];
      const atuaisIds = atuais.map((p) => p.id);
      const novas = imagens ?? [];

      if ((acao === "adicionar" || acao === "substituir") && novas.length === 0) return errorResult("Informe 'imagens' para adicionar ou substituir.");
      if (acao === "remover" && !remover_ids?.length) return errorResult("Informe 'remover_ids'.");
      if (acao === "reordenar") {
        if (!ordem_ids?.length) return errorResult("Informe 'ordem_ids' com todos os IDs na nova ordem.");
        const faltam = atuaisIds.filter((id) => !ordem_ids.includes(id));
        const estranhos = ordem_ids.filter((id) => !atuaisIds.includes(id));
        if (faltam.length || estranhos.length)
          return errorResult(`'ordem_ids' precisa conter exatamente as fotos atuais. Faltando: ${faltam.join(", ") || "—"}; desconhecidos: ${estranhos.join(", ") || "—"}`);
      }

      const descNova = (n: z.infer<typeof imagemSchema>, i: number) => `nova ${i + 1}: ${n.url ?? `(arquivo${n.nome ? ` ${n.nome}` : ""})`}`;
      let planoTxt: string[] = [];
      if (acao === "adicionar") {
        const pos = Math.min((posicao ?? atuais.length + 1) - 1, atuais.length);
        const lista = [...atuaisIds.map((id) => `atual ${id}`)];
        lista.splice(pos, 0, ...novas.map(descNova));
        planoTxt = lista;
      } else if (acao === "substituir") planoTxt = novas.map(descNova);
      else if (acao === "remover") planoTxt = atuaisIds.filter((id) => !remover_ids!.includes(id)).map((id) => `atual ${id}`);
      else planoTxt = ordem_ids!.map((id) => `atual ${id}`);

      if (planoTxt.length > 12) return errorResult(`O anúncio ficaria com ${planoTxt.length} fotos; o máximo da ML é 12.`);
      if (planoTxt.length === 0) return errorResult("O anúncio ficaria sem nenhuma foto — a ML não permite.");

      const previa =
        `${mlb} — ${item.title}\n` +
        `Fotos atuais (${atuais.length}):\n${atuais.map((p, i) => `  ${i + 1}. ${p.id} ${p.secure_url ?? p.url ?? ""}`).join("\n") || "  (nenhuma)"}\n` +
        `Como ficará (${planoTxt.length}):\n${planoTxt.map((t, i) => `  ${i + 1}. ${t}${i === 0 ? "  <- capa" : ""}`).join("\n")}` +
        (planoTxt.length < 3 ? "\nAviso: menos de 3 fotos — a ML recomenda pelo menos 3." : "");

      if (!confirmar) {
        return ok(`PRÉVIA — nada foi alterado ainda.\n${previa}\n\nPara aplicar, chame de novo com confirmar=true (após o OK do usuário).`, {
          previa: true,
          atuais,
          plano: planoTxt,
        });
      }

      // Converte as novas imagens em referências aceitas pela ML
      const novasPics: Pic[] = [];
      for (const n of novas) {
        if (n.url) novasPics.push({ source: n.url });
        else {
          const up = await uploadPicture(seller, n.base64!, n.nome ?? "foto.jpg");
          novasPics.push({ id: up.id });
        }
      }

      let pictures: Pic[];
      if (acao === "adicionar") {
        const pos = Math.min((posicao ?? atuais.length + 1) - 1, atuais.length);
        pictures = atuaisIds.map((id) => ({ id }));
        pictures.splice(pos, 0, ...novasPics);
      } else if (acao === "substituir") pictures = novasPics;
      else if (acao === "remover") pictures = atuaisIds.filter((id) => !remover_ids!.includes(id)).map((id) => ({ id }));
      else pictures = ordem_ids!.map((id) => ({ id }));

      await mlPut(seller, `/items/${mlb}`, { pictures });
      const depois = await getItem(seller, mlb);
      return ok(
        `Fotos atualizadas em ${mlb}. Agora são ${depois.pictures?.length ?? 0}:\n${(depois.pictures ?? []).map((p, i) => `  ${i + 1}. ${p.id} ${p.secure_url ?? p.url ?? ""}`).join("\n")}\n` +
          `Obs.: a ML pode levar alguns minutos para processar e moderar fotos novas.`,
        { pictures: depois.pictures }
      );
    } catch (err) {
      return toErrorResult(err, "atualizar_imagens_anuncio");
    }
  },
};
