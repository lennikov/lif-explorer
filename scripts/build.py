#!/usr/bin/env python3
"""Reassemble the v2.1 standalone HTML from annotated source files."""
import argparse
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
JS=['lif-reader.js','tiff-export.js','image-display.js','memory.js','colocalization.js','rotation.js','video-export.js','app.js']
def clean(s):
    if s.startswith('/* @repository-note'):
        end=s.find('*/\n')
        if end<0: raise ValueError('Unclosed source annotation')
        return s[end+3:]
    return s
def build():
    page=(ROOT/'src/template.html').read_text(encoding='utf-8')
    page=page.replace('@@LIF_STYLE@@',clean((ROOT/'src/style.css').read_text(encoding='utf-8')))
    for idx,name in enumerate(JS,1):
        page=page.replace(f'@@LIF_SCRIPT_{idx:02d}@@',clean((ROOT/'src'/name).read_text(encoding='utf-8')))
    if '@@LIF_' in page: raise ValueError('Missing LIF module')
    return page
if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--check',action='store_true')
    parser.add_argument('--output',default=str(ROOT/'LIF_Studio.html'))
    args=parser.parse_args()
    target=Path(args.output)
    content=build()
    if args.check:
        if target.read_text(encoding='utf-8') != content: raise SystemExit('Build does not match archived release')
        print('OK: byte-identical v2.1 build')
    else:
        target.write_text(content,encoding='utf-8')
        print('Saved',target)
