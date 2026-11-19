import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import iconv from 'iconv-lite';
import { deflateRawSync } from 'node:zlib';
import { parseCamt } from '../../src/domain/imports/camt-parser.js';
import { parseFrenchCsv } from '../../src/domain/imports/csv-parser.js';
import { parseXlsx } from '../../src/domain/imports/xlsx-parser.js';
import { parseOfx } from '../../src/domain/imports/ofx-parser.js';

function camtDoc(ntries: string, version = '001.08'): Buffer {
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.${version}">
  <BkToCstmrStmt><Stmt>${ntries}</Stmt></BkToCstmrStmt>
</Document>`,
    'utf-8',
  );
}

describe('camt parser audit', () => {
  it('ignores pending entries whose status is wrapped in <Cd> (camt.053.001.08+)', () => {
    const buf = camtDoc(
      `<Ntry><Amt Ccy="EUR">10.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts><Cd>PDNG</Cd></Sts>` +
        `<BookgDt><Dt>2026-06-15</Dt></BookgDt><NtryDtls><TxDtls><RmtInf><Ustrd>PENDING</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>` +
        `<Ntry><Amt Ccy="EUR">20.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts>` +
        `<BookgDt><Dt>2026-06-16</Dt></BookgDt><NtryDtls><TxDtls><RmtInf><Ustrd>BOOKED</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`,
    );
    expect(parseCamt(buf).map((r) => r.rawLabel)).toEqual(['BOOKED']);
  });

  it('decodes XML entities and CDATA in remittance text', () => {
    const buf = camtDoc(
      `<Ntry><Amt Ccy="EUR">10.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts>` +
        `<BookgDt><Dt>2026-06-15</Dt></BookgDt><NtryDtls><TxDtls><RmtInf><Ustrd>AT&amp;T &lt;ref&gt;</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>` +
        `<Ntry><Amt Ccy="EUR">5.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts>` +
        `<BookgDt><Dt>2026-06-16</Dt></BookgDt><NtryDtls><TxDtls><RmtInf><Ustrd><![CDATA[R&D refund]]></Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`,
      '001.02',
    );
    expect(parseCamt(buf).map((r) => r.rawLabel)).toEqual(['AT&T <ref>', 'R&D refund']);
  });
});

describe('csv/xlsx debit-credit pair audit', () => {
  it('csv: a "0,00" debit cell on a credit row does not mask the credit', () => {
    const csv = 'Date;Libellé;Débit;Crédit\n01/02/2026;SALAIRE;0,00;1 500,00\n02/02/2026;ACHAT;12,50;0,00\n';
    expect(parseFrenchCsv(Buffer.from(csv, 'utf-8')).map((r) => r.amount)).toEqual(['1500.00', '-12.50']);
  });

  it('csv: a row with an empty amount is skipped instead of yielding amount ""', () => {
    const csv = 'Date;Libellé;Montant\n01/02/2026;SOLDE REPORTE;\n02/02/2026;ACHAT;-3,00\n';
    expect(parseFrenchCsv(Buffer.from(csv, 'utf-8')).map((r) => r.amount)).toEqual(['-3.00']);
  });

  it('xlsx: a numeric 0 debit cell on a credit row does not mask the credit', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(['Date', 'Libellé', 'Débit', 'Crédit']);
    ws.addRow([new Date(Date.UTC(2026, 5, 15)), 'SALAIRE', 0, 1500]);
    ws.addRow([new Date(Date.UTC(2026, 5, 16)), 'ACHAT', 12.5, 0]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    expect((await parseXlsx(buf)).map((r) => r.amount)).toEqual(['1500.00', '-12.50']);
  });
});

describe('xlsx resource bounds audit', () => {
  it('does not scan every column of a sparse sheet whose used range is huge', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(['Date', 'Libellé', 'Montant']);
    ws.addRow([new Date(Date.UTC(2026, 5, 15)), 'A', -1]);
    // One stray cell in the last column of row 3000 widens columnCount to 16384.
    ws.getCell('XFD3000').value = 'x';
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const t0 = Date.now();
    const rows = await parseXlsx(buf);
    expect(rows).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('rejects a workbook whose archive inflates far beyond the upload size', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    // 300 MB of zeros deflates to ~300 KB.
    zip.file('xl/big.bin', Buffer.alloc(300 * 1024 * 1024), { compression: 'DEFLATE' });
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect(buf.length).toBeLessThan(5 * 1024 * 1024);
    await expect(parseXlsx(buf)).rejects.toThrow(/too large|expands/i);
  }, 60_000);

  it('rejects an archive whose central directory understates the inflated size', async () => {
    // Hand-built single-entry zip: declared uncompressed size 10 bytes, real payload 300 MB.
    const payload = deflateRawSync(Buffer.alloc(300 * 1024 * 1024));
    const name = Buffer.from('xl/big.bin');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(10, 22);
    local.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(10, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(0, 42);
    const cdOffset = local.length + name.length + payload.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(cd.length + name.length, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    const buf = Buffer.concat([local, name, payload, cd, name, eocd]);
    await expect(parseXlsx(buf)).rejects.toThrow(/too large|expands/i);
  }, 60_000);
});

describe('ofx audit', () => {
  const body = (name: string, amt = '-5.00') =>
    `<OFX><STMTTRN><DTPOSTED>20260615<TRNAMT>${amt}<FITID>1<NAME>${name}</STMTTRN></OFX>`;

  it('decodes windows-1252 bytes when CHARSET is NONE', () => {
    const text = `OFXHEADER:100\r\nDATA:OFXSGML\r\nENCODING:USASCII\r\nCHARSET:NONE\r\n\r\n${body('CAFÉ DU COIN')}`;
    expect(parseOfx(iconv.encode(text, 'windows-1252'))[0]!.rawLabel).toBe('CAFÉ DU COIN');
  });

  it('honours the encoding declared in an OFX 2.x XML prolog', () => {
    const text = `<?xml version="1.0" encoding="ISO-8859-1"?>\r\n<?OFX OFXHEADER="200" VERSION="211"?>\r\n${body('CAFÉ DU COIN')}`;
    expect(parseOfx(iconv.encode(text, 'iso-8859-1'))[0]!.rawLabel).toBe('CAFÉ DU COIN');
  });

  it('decodes XML entities in NAME/MEMO', () => {
    const text = `OFXHEADER:100\r\nCHARSET:UTF-8\r\n\r\n${body('AT&amp;T &quot;PRO&quot;')}`;
    expect(parseOfx(Buffer.from(text, 'utf-8'))[0]!.rawLabel).toBe('AT&T "PRO"');
  });

  it('accepts an explicit leading + on TRNAMT', () => {
    const text = `OFXHEADER:100\r\nCHARSET:UTF-8\r\n\r\n${body('SALAIRE', '+1500.00')}`;
    expect(parseOfx(Buffer.from(text, 'utf-8'))[0]!.amount).toBe('1500.00');
  });
});
