/*
=============================================================================
FILE: public/qrHelper.js
VERSION: v19.6.16-verifactu-qr-generator
RESPONSIBILITY: Generates Veri*Factu QR verification URLs for fiscal receipts.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
=============================================================================
*/
export function generateVerifactuQrUrl(params = {}) {
const nifEmisor = String(params.businessTaxId || "").trim();
const numFactura = String(params.invoiceNumber || params.numFactura || "").trim();
const fechaEmision = String(params.fechaEmision || "").trim();
const qrImporteTotal = String(params.totalAmount || "0").trim();
const hashCadena = String(params.currentRecordHash || "").trim();
if (!nifEmisor || !numFactura || !fechaEmision) {
return null;
}
const baseUrl = "https://www.agenciatributaria.gob.es/verifactu/verify";
const queryParams = [
`nif=${encodeURIComponent(nifEmisor)}`,
`numFactura=${encodeURIComponent(numFactura)}`,
`fecha=${encodeURIComponent(fechaEmision)}`,
`importe=${encodeURIComponent(qrImporteTotal)}`,
`hash=${encodeURIComponent(hashCadena)}`,
].join("&");
return `${baseUrl}?${queryParams}`;
}
export function extractVerifactuData(movimiento = {}) {
return {
nifEmisor: String(movimiento.businessTaxId || "").trim(),
numTicketFactura: String(movimiento.invoiceNumber || "").trim(),
fechaEmision: String(movimiento.registeredAt || "").slice(0, 10),
totalAmount: String(movimiento.totalAmount || 0),
hashCadena: String(movimiento.currentRecordHash || "").trim(),
firmaDigital: String(movimiento.digitalSignature || "").trim(),
qrUrl: generateVerifactuQrUrl(movimiento),
};
}
export function buildVerifactuReceiptHtml(movimiento = {}) {
const data = extractVerifactuData(movimiento);
if (!data.qrUrl) return "";
return `
<div style="font-family: Arial, sans-serif; padding: 16px; border: 1px solid #ccc; border-radius: 8px;">
<h3 style="margin: 0 0 12px;">Factura Simplificada</h3>
<p><strong>NIF Emisor:</strong> ${data.businessTaxId}</p>
<p><strong>Numero:</strong> ${data.invoiceNumber}</p>
<p><strong>Fecha:</strong> ${data.fechaEmision}</p>
<p><strong>Importe:</strong> ${data.totalAmount} EUR</p>
<p><strong>Verificacion:</strong> <a href="${data.qrUrl}" target="_blank">Verificar factura</a></p>
<p style="font-size: 10px; color: #666;">Hash: ${data.currentRecordHash.substring(0, 16)}...</p>
</div>
`;
}