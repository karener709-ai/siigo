import type { NormalizedInvoice } from '../siigo/types.js';

/**
 * Mismo formato que en Siigo (detalle vencimiento): prefijo FV-1- y el número completo que venga de Siigo.
 * Si el dato ya incluye FV-1-, se normaliza a mayúsculas y no se duplica el prefijo.
 */
function formatInvoiceForHubSpot(raw: string): string {
  const s = String(raw).trim();
  if (!s) return '';
  const m = s.match(/^fv-1-(.+)$/i);
  if (m) return `FV-1-${m[1]!.trim()}`;
  return `FV-1-${s}`;
}

/** Datos de cartera por empresa listos para HubSpot */
export interface CompanyCartera {
  cartera_2023: number;
  numero_de_factura_2023: string;
  cartera_2024: number;
  numero_de_factura_2024: string;
  saldo_2025: number;
  numero_de_factura_2025: string;
  cartera_2026: number;
  numero_de_factura_2026: string;
  centro_de_costo: string;
  /** Mayor cantidad de días vencidos entre las facturas abiertas (0 = ninguna vencida). */
  dias_en_mora: number;
}

const EMPTY_CARTERA: CompanyCartera = {
  cartera_2023: 0,
  numero_de_factura_2023: '',
  cartera_2024: 0,
  numero_de_factura_2024: '',
  saldo_2025: 0,
  numero_de_factura_2025: '',
  cartera_2026: 0,
  numero_de_factura_2026: '',
  centro_de_costo: '',
  dias_en_mora: 0,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Días transcurridos desde `due_date` hasta hoy; 0 si aún no vence o no hay fecha. */
function diasVencidos(dueDateIso: string | null): number {
  if (!dueDateIso) return 0;
  const due = new Date(dueDateIso);
  if (Number.isNaN(due.getTime())) return 0;

  const dueDay = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate());
  const now = new Date();
  const todayDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  const dias = Math.floor((todayDay - dueDay) / MS_PER_DAY);
  return dias > 0 ? dias : 0;
}

/** Cartera en ceros / vacía: útil cuando Siigo no devuelve facturas abiertas pero hay que marcar HubSpot “al día”. */
export function emptyCompanyCartera(): CompanyCartera {
  return { ...EMPTY_CARTERA };
}

function accumulate(
  company: CompanyCartera,
  saldoField: keyof Pick<
    CompanyCartera,
    'cartera_2023' | 'cartera_2024' | 'saldo_2025' | 'cartera_2026'
  >,
  facturaField: keyof Pick<
    CompanyCartera,
    | 'numero_de_factura_2023'
    | 'numero_de_factura_2024'
    | 'numero_de_factura_2025'
    | 'numero_de_factura_2026'
  >,
  invoice: NormalizedInvoice
): void {
  const saldo = company[saldoField];
  (company as unknown as Record<string, number>)[saldoField] = (saldo ?? 0) + invoice.balance;
  if (invoice.document_type !== 'invoice') return;

  const dias = diasVencidos(invoice.due_date);
  if (dias > company.dias_en_mora) company.dias_en_mora = dias;

  const piece = formatInvoiceForHubSpot(invoice.invoice_number);
  if (!piece) return;
  const current = company[facturaField];
  (company as unknown as Record<string, string>)[facturaField] = current ? `${current}, ${piece}` : piece;
}

/** Suma saldos de cartera por año (facturas abiertas ya filtradas en el mapa). */
export function totalSaldoCarteraAbierta(data: CompanyCartera): number {
  return (
    (Number.isFinite(data.cartera_2023) ? data.cartera_2023 : 0) +
    (Number.isFinite(data.cartera_2024) ? data.cartera_2024 : 0) +
    (Number.isFinite(data.saldo_2025) ? data.saldo_2025 : 0) +
    (Number.isFinite(data.cartera_2026) ? data.cartera_2026 : 0)
  );
}

/** Agrupa facturas por NIT y genera payload de cartera por año para HubSpot. */
export function mapInvoicesToCarteraByNit(invoices: NormalizedInvoice[]): Map<string, CompanyCartera> {
  const result = new Map<string, CompanyCartera>();
  const costCenters = new Map<string, Set<string>>();

  for (const invoice of invoices) {
    const nit = invoice.nit;
    const year = invoice.year;

    if (!result.has(nit)) {
      result.set(nit, { ...EMPTY_CARTERA });
      costCenters.set(nit, new Set());
    }

    const company = result.get(nit)!;
    if (year <= 2023) accumulate(company, 'cartera_2023', 'numero_de_factura_2023', invoice);
    else if (year === 2024) accumulate(company, 'cartera_2024', 'numero_de_factura_2024', invoice);
    else if (year === 2025) accumulate(company, 'saldo_2025', 'numero_de_factura_2025', invoice);
    else if (year === 2026) accumulate(company, 'cartera_2026', 'numero_de_factura_2026', invoice);

    if (invoice.cost_center.trim() !== '') costCenters.get(nit)!.add(invoice.cost_center);
  }

  for (const [nit, company] of result) {
    const set = costCenters.get(nit);
    company.centro_de_costo = set ? [...set].sort().join(', ') : '';

    if ((company.cartera_2023 ?? 0) === 0) company.numero_de_factura_2023 = '';
    if ((company.cartera_2024 ?? 0) === 0) company.numero_de_factura_2024 = '';
    if ((company.saldo_2025 ?? 0) === 0) company.numero_de_factura_2025 = '';
    if ((company.cartera_2026 ?? 0) === 0) company.numero_de_factura_2026 = '';
  }

  return result;
}
