#!/usr/bin/env python3
"""Integrate V2 after viewer.render(...) without overwriting other POC changes."""
from pathlib import Path
import re
import sys

path = Path('src/main.js')
if not path.exists() or not Path('src/benchmark-v2.js').exists():
    sys.exit('ERROR: ejecutar desde la raíz del repo wsi-viewer-poc después de git apply.')
source = path.read_text(encoding='utf-8')
if 'installViewerBenchmarkV2' in source:
    sys.exit('ERROR: V2 ya parece integrado. No se efectuaron cambios.')

render = re.search(r'viewer\.render\s*\(\s*\{\s*container\s*:\s*["\']viewport["\']\s*,?\s*\}\s*\)\s*;', source)
if not render:
    sys.exit('ERROR: no encontré viewer.render({container:"viewport"});. No modifiqué main.js.')

imports = '''import { installViewerBenchmarkV2 } from "./benchmark-v2.js";
import "./benchmark-v2.css";
'''
anchor = 'import "ol/ol.css";'
if anchor not in source:
    sys.exit('ERROR: no encontré import "ol/ol.css";. No modifiqué main.js.')
source_new = source.replace(anchor, anchor+'\n'+imports,1)
render2 = re.search(r'viewer\.render\s*\(\s*\{\s*container\s*:\s*["\']viewport["\']\s*,?\s*\}\s*\)\s*;', source_new)
call = '''

    // Benchmark V2: activo solo en desarrollo o con ?benchmark=1.
    // No modifica el flujo DICOMweb ni el renderizado clínico.
    installViewerBenchmarkV2({ viewer, volumeImages, container: "viewport" });'''
source_new=source_new[:render2.end()]+call+source_new[render2.end():]
backup=Path('src/main.js.benchmark-v2-backup')
if backup.exists():sys.exit('ERROR: ya existe backup V2; revisa antes de sobrescribir.')
backup.write_text(source,encoding='utf-8')
path.write_text(source_new,encoding='utf-8')
print('OK: Benchmark V2 integrado. Backup:',backup)
print('Activación en producción: añadir ?benchmark=1 a la URL del visor.')
