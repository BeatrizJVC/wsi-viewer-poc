import assert from 'node:assert/strict';
import test from 'node:test';
import {
  rewriteBulkDataURIs,
  selectPyramidImages,
  buildPyramidImages,
  getBaseDimensions,
  describeLevels,
} from '../src/wsi/dicom-metadata.js';

const image = (flavor, columns = 0, rows = 0) => ({
  ImageType: ['DERIVED', 'PRIMARY', flavor],
  TotalPixelMatrixColumns: columns,
  TotalPixelMatrixRows: rows,
});

test('reescribe BulkDataURI absolutos anidados y respeta los demás valores', () => {
  const metadata = [{
    '7FE00010': { vr: 'OB', BulkDataURI: 'http://localhost:8042/dicom-web/studies/1.2/series/3.4/instances/5.6/bulk/7FE00010' },
    '52009229': { Value: [{ '00289110': { Value: [{ X: { BulkDataURI: 'http://other:1/dicom-web/a/b' } }] } }] },
    '00100010': { vr: 'PN', Value: [{ Alphabetic: 'X' }] },
    '00000001': { BulkDataURI: 'http://localhost/no-dicomweb-path' },
  }];
  const seen = [];
  const count = rewriteBulkDataURIs(metadata, 'https://gw.example/dicom-web/', (from, to) => seen.push([from, to]));
  assert.equal(count, 2);
  assert.equal(metadata[0]['7FE00010'].BulkDataURI,
    'https://gw.example/dicom-web/studies/1.2/series/3.4/instances/5.6/bulk/7FE00010');
  assert.equal(metadata[0]['52009229'].Value[0]['00289110'].Value[0].X.BulkDataURI, 'https://gw.example/dicom-web/a/b');
  assert.equal(metadata[0]['00000001'].BulkDataURI, 'http://localhost/no-dicomweb-path');
  assert.deepEqual(metadata[0]['00100010'], { vr: 'PN', Value: [{ Alphabetic: 'X' }] });
  assert.equal(seen.length, 2);
});

test('acepta una base relativa sin barra final', () => {
  const metadata = { BulkDataURI: 'http://localhost:8042/dicom-web/studies/1/bulk' };
  rewriteBulkDataURIs(metadata, '/dicom-web');
  assert.equal(metadata.BulkDataURI, '/dicom-web/studies/1/bulk');
});

test('tolera valores nulos y primitivos', () => {
  assert.equal(rewriteBulkDataURIs(null, '/x'), 0);
  assert.equal(rewriteBulkDataURIs([1, 'a', null, { a: undefined }], '/x'), 0);
});

test('la pirámide incluye VOLUME y THUMBNAIL y excluye LABEL, OVERVIEW y desconocidos', () => {
  const images = [image('VOLUME'), image('LABEL'), image('THUMBNAIL'), image('OVERVIEW'), {}, image('VOLUME')];
  assert.deepEqual(selectPyramidImages(images).map(i => i.ImageType?.[2]), ['VOLUME', 'THUMBNAIL', 'VOLUME']);
});

test('buildPyramidImages omite instancias que la fábrica no puede interpretar', () => {
  const raw = [{ f: 'VOLUME' }, { f: 'bad' }, { f: 'LABEL' }, { f: 'THUMBNAIL' }];
  const { images, skipped } = buildPyramidImages(raw, ({ f }) => {
    if (f === 'bad') throw new Error('invalid');
    return image(f);
  });
  assert.deepEqual(images.map(i => i.ImageType[2]), ['VOLUME', 'THUMBNAIL']);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].index, 1);
  assert.equal(skipped[0].error.message, 'invalid');
});

test('las dimensiones base vienen del VOLUME más grande, ignorando THUMBNAIL', () => {
  const images = [image('VOLUME', 1000, 800), image('THUMBNAIL', 99999, 99999), image('VOLUME', 40000, 30000), image('VOLUME', 10000, 7500)];
  assert.deepEqual(getBaseDimensions(images), { width: 40000, height: 30000 });
  assert.equal(getBaseDimensions([image('THUMBNAIL', 10, 10)]), null);
  assert.equal(getBaseDimensions([]), null);
});

test('describeLevels resume solo niveles VOLUME desde los tags', () => {
  const volume = {
    '00080008': { Value: ['ORIGINAL', 'PRIMARY', 'VOLUME', 'NONE'] },
    '00080018': { Value: ['1.2.3'] },
    '00280008': { Value: [120] },
    '00480006': { Value: [4096] },
    '00480007': { Value: [2048] },
    '52009229': { Value: [{ '00289110': { Value: [{ '00280030': { Value: [0.00025, 0.00025] } }] } }] },
  };
  const label = { '00080008': { Value: ['ORIGINAL', 'PRIMARY', 'LABEL'] } };
  assert.deepEqual(describeLevels([label, volume]), [{
    nivel: 1, sopInstanceUID: '1.2.3', numberOfFrames: 120,
    totalPixelMatrixColumns: 4096, totalPixelMatrixRows: 2048, pixelSpacing: [0.00025, 0.00025],
  }]);
});
