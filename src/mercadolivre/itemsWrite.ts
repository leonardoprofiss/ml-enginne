import { mlPost, mlPut } from "./client.js";
import { getItem, type MlItem } from "./endpoints.js";

/**
 * Wrappers de ESCRITA sobre `/items` (V2 — a V1 era só leitura). Ao
 * contrário do resto de `endpoints.ts`, aqui cada chamada muda dado real no
 * Mercado Livre. Mantido em arquivo separado de propósito: é a superfície
 * inteira de "coisas que a Enginne pode alterar num anúncio real" — fácil de
 * auditar de uma vez.
 *
 * Documentação de referência: https://developers.mercadolivre.com.br/pt_br/gerenciamento-de-produtos
 * (recursos `POST /items`, `PUT /items/{id}`, `PUT|POST /items/{id}/description`).
 */

export interface CreateItemInput {
  title: string;
  category_id: string;
  price: number;
  available_quantity: number;
  /** ID do tipo de anúncio (ex.: "gold_special", "gold_pro") — varia por plano/categoria da conta. Sem default: pedir explicitamente evita escolher um tipo de anúncio mais caro/mais barato do que o vendedor queria. */
  listing_type_id: string;
  currency_id?: string; // default BRL
  buying_mode?: string; // default "buy_it_now"
  condition?: "new" | "used"; // default "new"
  description?: string;
  /** URLs de imagens públicas (https). */
  pictures?: string[];
  attributes?: Array<{ id: string; value_name?: string; value_id?: string }>;
}

/**
 * Cria um anúncio novo (POST /items). Se `description` for informado, faz
 * uma segunda chamada para setar a descrição — se essa segunda chamada
 * falhar, o anúncio já foi criado (não há como desfazer via API), então o
 * erro é reportado separadamente para quem chamou tentar de novo só a
 * descrição via `updateItem`.
 */
export async function createItem(sellerName: string, input: CreateItemInput): Promise<{ item: MlItem; descriptionError?: string }> {
  const body: Record<string, unknown> = {
    title: input.title,
    category_id: input.category_id,
    price: input.price,
    currency_id: input.currency_id ?? "BRL",
    available_quantity: input.available_quantity,
    buying_mode: input.buying_mode ?? "buy_it_now",
    condition: input.condition ?? "new",
    listing_type_id: input.listing_type_id,
    attributes: input.attributes,
    pictures: input.pictures?.map((source) => ({ source })),
  };

  const item = await mlPost<MlItem>(sellerName, "/items", body);

  let descriptionError: string | undefined;
  if (input.description) {
    try {
      await setItemDescription(sellerName, item.id, input.description);
    } catch (err) {
      descriptionError = err instanceof Error ? err.message : String(err);
    }
  }

  return { item, descriptionError };
}

/** PUT (ou POST como fallback, se ainda não existir descrição) em /items/{id}/description. */
export async function setItemDescription(sellerName: string, itemId: string, plainText: string): Promise<void> {
  try {
    await mlPut(sellerName, `/items/${itemId}/description`, { plain_text: plainText });
  } catch (err: any) {
    // 404 aqui tipicamente significa "este anúncio ainda não tem descrição" — nesse caso é POST, não PUT.
    if (err?.status === 404) {
      await mlPost(sellerName, `/items/${itemId}/description`, { plain_text: plainText });
      return;
    }
    throw err;
  }
}

export interface UpdateItemInput {
  title?: string;
  price?: number;
  available_quantity?: number;
  status?: "active" | "paused";
  description?: string;
}

/**
 * Atualiza um anúncio existente (PUT /items/{id} para os campos que vieram
 * preenchidos, PUT/POST /items/{id}/description separadamente se
 * `description` foi informado). Campos não informados em `input` não são
 * tocados. Sempre retorna o estado FINAL do item (busca de novo se só a
 * descrição mudou, já que PUT /items/{id} não foi chamado nesse caso).
 */
export async function updateItem(sellerName: string, itemId: string, input: UpdateItemInput): Promise<MlItem> {
  const body: Record<string, unknown> = {};
  if (input.title !== undefined) body.title = input.title;
  if (input.price !== undefined) body.price = input.price;
  if (input.available_quantity !== undefined) body.available_quantity = input.available_quantity;
  if (input.status !== undefined) body.status = input.status;

  let item: MlItem | undefined;
  if (Object.keys(body).length > 0) {
    item = await mlPut<MlItem>(sellerName, `/items/${itemId}`, body);
  }

  if (input.description !== undefined) {
    await setItemDescription(sellerName, itemId, input.description);
  }

  return item ?? (await getItem(sellerName, itemId));
}
