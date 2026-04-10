import { z } from 'zod';

export type SiigoDocumentType = 'invoice' | 'credit_note';

/** Documento normalizado interno (factura o nota crédito) tras validar respuesta de Siigo.
 *  Además de los campos resumidos que usa el sync, se conserva el
 *  objeto completo devuelto por Siigo en `raw` para poder acceder a
 *  cualquier otro dato del estado de cuenta cuando haga falta.
 */
export interface NormalizedInvoice {
  document_type: SiigoDocumentType;
  nit: string;
  year: number;
  invoice_number: string;
  balance: number;
  cost_center: string;
  date: string;
  raw: SiigoInvoiceListItem | SiigoCreditNoteListItem;
}

/**
 * Ítem devuelto por Siigo en GET /invoices.
 * El listado paginado usa `date`; otros payloads pueden usar `issue_date`.
 * `number` puede venir como string o número; `cost_center` como id o como objeto con nombre.
 */
export const SiigoInvoiceListItemSchema = z.object({
  number: z.union([z.string(), z.number()]),
  balance: z.number(),
  issue_date: z.string().optional(),
  date: z.string().optional(),
  customer: z.object({ identification: z.string() }),
  cost_center: z
    .union([
      z.number(),
      z.string(),
      z.object({ name: z.string().optional().nullable() }),
      z.null(),
    ])
    .optional(),
});

export type SiigoInvoiceListItem = z.infer<typeof SiigoInvoiceListItemSchema>;

/** @deprecated usar SiigoInvoiceListItem; se mantiene alias por compatibilidad */
export type SiigoInvoiceItem = SiigoInvoiceListItem;

export const SiigoInvoicesResponseSchema = z.array(SiigoInvoiceListItemSchema);

export const SiigoCreditNoteListItemSchema = z.object({
  id: z.string().optional(),
  number: z.union([z.string(), z.number()]).optional(),
  name: z.string().min(1),
  date: z.string(),
  invoice_data: z
    .object({
      date: z.string().optional(),
    })
    .optional(),
  total: z.number(),
  customer: z.object({ identification: z.string() }),
  invoice: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
  cost_center: z
    .union([
      z.number(),
      z.string(),
      z.object({ name: z.string().optional().nullable() }),
      z.null(),
    ])
    .optional(),
});

export type SiigoCreditNoteListItem = z.infer<typeof SiigoCreditNoteListItemSchema>;
