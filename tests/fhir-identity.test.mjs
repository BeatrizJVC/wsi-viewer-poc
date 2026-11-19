import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const fhirBase = 'https://fhir.example.test/fhir';
const search = '/fhir/DiagnosticReport?subject=Patient%2Fpat-case-1&_format=json';
const source = await readFile(new URL('../src/fhir.js', import.meta.url), 'utf8');
const { resolveImagingForCase, getCases } = await import(
  `data:text/javascript;base64,${Buffer.from(source
    .replace('import.meta.env.VITE_FHIR_URL', JSON.stringify(fhirBase))
    .replace('import.meta.env.VITE_DICOMWEB_URL', JSON.stringify('https://fallback.example.test/dicom-web')))
    .toString('base64')}`
);

function report(...references) {
  return { resourceType: 'DiagnosticReport', subject: { reference: 'Patient/pat-case-1' },
    imagingStudy: references.map(reference => ({ reference })) };
}

function bundle(...reports) {
  return { entry: reports.map(resource => ({ resource })) };
}

function mockFhir(t, responses) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const { pathname, search } = new URL(url);
    const key = pathname + search;
    requests.push(key);
    assert.ok(Object.hasOwn(responses, key), `Unexpected request: ${key}`);
    return { ok: true, json: async () => responses[key] };
  });
  return requests;
}

const seriesA = { uid: '1.2.3', instance: [{ uid: '1.2.3.4' }] };
const seriesB = { uid: '1.2.5', instance: [{ uid: '1.2.5.6' }],
  endpoint: [{ reference: 'Endpoint/series-b' }] };
const study = {
  resourceType: 'ImagingStudy',
  id: 'study-a',
  identifier: [{ value: 'accession' }, { system: 'urn:dicom:uid', value: 'urn:oid:1.2' }],
  endpoint: [{ reference: 'Endpoint/study-a' }],
  series: [seriesA],
};
const endpoint = id => ({
  resourceType: 'Endpoint', id, address: `https://${id}.example.test/dicom-web`,
});

test('una URL antigua resuelve un único estudio y la serie predeterminada', async t => {
  mockFhir(t, {
    [search]: bundle(report('ImagingStudy/study-a'), report(`${fhirBase}/ImagingStudy/study-a`)),
    '/fhir/ImagingStudy/study-a': study,
    '/fhir/Endpoint/study-a': endpoint('study-a'),
  });
  const resolved = await resolveImagingForCase('case-1');
  assert.equal(resolved.imagingStudyReference, 'ImagingStudy/study-a');
  assert.equal(resolved.studyInstanceUID, '1.2');
  assert.equal(resolved.seriesInstanceUID, seriesA.uid);
  assert.equal(resolved.dicomWebUrl, endpoint('study-a').address);
});

test('la resolución antigua detecta otro estudio en una página posterior', async t => {
  const nextPage = '/fhir/DiagnosticReport?page=2';
  const requests = mockFhir(t, {
    [search]: { ...bundle(report('ImagingStudy/study-a')),
      link: [{ relation: 'next', url: nextPage }] },
    [nextPage]: bundle(report('ImagingStudy/study-b')),
  });
  await assert.rejects(resolveImagingForCase('case-1'), /estudio del caso es ambiguo/);
  assert.deepEqual(requests, [search, nextPage]);
});

test('permite elegir un estudio de un informe con varias referencias', async t => {
  const studyB = { ...study, id: 'study-b', identifier: [{ value: 'urn:oid:1.9' }],
    series: [{ uid: '1.9.3' }], endpoint: [] };
  const responses = {
    [search]: bundle(report('ImagingStudy/study-a', 'ImagingStudy/study-b')),
    '/fhir/DiagnosticReport?_count=100&_format=json':
      bundle(report('ImagingStudy/study-a', 'ImagingStudy/study-b')),
    '/fhir/ImagingStudy/study-a': study,
    '/fhir/ImagingStudy/study-b': studyB,
    '/fhir/Patient/pat-case-1': { id: 'pat-case-1' },
  };
  mockFhir(t, responses);
  const cases = await getCases();
  assert.deepEqual(new Set(cases.map(item => item.imagingStudyReference)),
    new Set(['ImagingStudy/study-a', 'ImagingStudy/study-b']));
  await assert.rejects(resolveImagingForCase('case-1'), /ambiguo/);
  await assert.rejects(resolveImagingForCase('case-1', {
    imagingStudyReference: 'ImagingStudy/unrelated',
  }), /no está vinculado/);
  const resolved = await resolveImagingForCase('case-1', { imagingStudyReference: 'ImagingStudy/study-b' });
  assert.equal(resolved.studyInstanceUID, '1.9');
  assert.equal(resolved.seriesInstanceUID, '1.9.3');
  await assert.rejects(resolveImagingForCase('case-1', {
    imagingStudyReference: 'ImagingStudy/study-b', seriesUID: seriesA.uid,
  }), /serie solicitada/);
});

test('al cambiar de serie utiliza las instancias y el endpoint de esa serie', async t => {
  const requests = mockFhir(t, {
    [search]: bundle(report('ImagingStudy/study-a')),
    '/fhir/ImagingStudy/study-a': { ...study, series: [seriesA, seriesB] },
    '/fhir/Endpoint/series-b': endpoint('series-b'),
  });
  const resolved = await resolveImagingForCase('case-1', {
    imagingStudyReference: 'ImagingStudy/study-a', seriesUID: seriesB.uid,
  });
  assert.equal(resolved.studyInstanceUID, '1.2');
  assert.equal(resolved.seriesInstanceUID, seriesB.uid);
  assert.deepEqual(resolved.instances, seriesB.instance);
  assert.equal(resolved.dicomWebUrl, endpoint('series-b').address);
  assert.ok(!requests.includes('/fhir/Endpoint/study-a'));
});

test('un enlace antiguo rechaza referencias de estudio sin resolver', async t => {
  mockFhir(t, {
    [search]: bundle(report('ImagingStudy/study-a', 'https://other.example.test/ImagingStudy/study-b')),
  });
  await assert.rejects(resolveImagingForCase('case-1'), /ambiguo/);
});

test('rechaza una respuesta ImagingStudy con un ID distinto al solicitado', async t => {
  mockFhir(t, {
    [search]: bundle(report('ImagingStudy/study-a')),
    '/fhir/ImagingStudy/study-a': { ...study, id: 'study-b' },
  });
  await assert.rejects(resolveImagingForCase('case-1'), /distinto del estudio seleccionado/);
});
