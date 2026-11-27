#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""绿幕抠像：把绿幕背景转为透明 PNG，边缘去溢色（despill），自动裁切。

算法要点
--------
1) 判绿用「归一化绿度」而不是绝对差值：
       excess = g - (r + b) / 2
       ratio  = excess / max(1, (r + b) / 2)
   暗角处绿幕的绝对差值很小但相对比例依然很高，用 ratio 才能稳定识别。
2) 从画面四边做连通扩散（Flood Fill）：只有与边界连通的绿色才被抠掉，
   猫身上因绿幕反光而发绿的部分（眼睛、反光）是内部连通区域，会被保留。
3) 抠除区域做距离衰减 → 柔和边缘；边缘同时做 despill 去掉溢出的绿。

用法：
    python tools/chromakey.py <输入目录> <输出目录> [ratio阈值]
"""
import os
import sys
from collections import deque
from PIL import Image


def green_ratio(r, g, b):
    """归一化绿度：越大越像绿幕。"""
    avg = (r + b) * 0.5
    if avg < 1:
        avg = 1.0
    if g <= r or g <= b:
        return 0.0
    return (g - avg) / avg


def chromakey(img, ratio_thresh=0.28):
    img = img.convert('RGBA')
    w, h = img.size
    px = img.load()

    # ---- 1) 标记所有"像绿幕"的像素 ----
    cand = bytearray(w * h)
    for y in range(h):
        row = y * w
        for x in range(w):
            r, g, b, _ = px[x, y]
            if green_ratio(r, g, b) > ratio_thresh:
                cand[row + x] = 1

    # ---- 2) 从四边做连通扩散，只保留与边界连通的绿幕 ----
    bg = bytearray(w * h)
    q = deque()

    def seed(x, y):
        i = y * w + x
        if cand[i] and not bg[i]:
            bg[i] = 1
            q.append(i)

    for x in range(w):
        seed(x, 0); seed(x, h - 1)
    for y in range(h):
        seed(0, y); seed(w - 1, y)

    while q:
        i = q.popleft()
        x = i % w; y = i // w
        if x > 0:
            j = i - 1
            if cand[j] and not bg[j]:
                bg[j] = 1; q.append(j)
        if x < w - 1:
            j = i + 1
            if cand[j] and not bg[j]:
                bg[j] = 1; q.append(j)
        if y > 0:
            j = i - w
            if cand[j] and not bg[j]:
                bg[j] = 1; q.append(j)
        if y < h - 1:
            j = i + w
            if cand[j] and not bg[j]:
                bg[j] = 1; q.append(j)

    # ---- 3) 多源 BFS 求到绿幕的像素距离 → 柔和边缘 ----
    INF = 255
    dist = [INF] * (w * h)
    q = deque()
    for i in range(w * h):
        if bg[i]:
            dist[i] = 0
            q.append(i)
    while q:
        i = q.popleft()
        d = dist[i]
        if d >= 5:
            continue
        x = i % w; y = i // w
        if x > 0:
            j = i - 1
            if dist[j] > d + 1:
                dist[j] = d + 1; q.append(j)
        if x < w - 1:
            j = i + 1
            if dist[j] > d + 1:
                dist[j] = d + 1; q.append(j)
        if y > 0:
            j = i - w
            if dist[j] > d + 1:
                dist[j] = d + 1; q.append(j)
        if y < h - 1:
            j = i + w
            if dist[j] > d + 1:
                dist[j] = d + 1; q.append(j)

    # ---- 4) 应用 alpha + despill ----
    out = Image.new('RGBA', (w, h))
    opx = out.load()
    EDGE = 4.0
    for y in range(h):
        row = y * w
        for x in range(w):
            d = dist[row + x]
            r, g, b, _ = px[x, y]
            if d >= INF:
                opx[x, y] = (r, g, b, 255)
                continue
            t = d / EDGE
            if t > 1.0:
                t = 1.0
            s = t * t * (3 - 2 * t)
            a = int(round(s * 255))
            if a > 0 and g > (r + b) * 0.5:
                limit = (r + b) * 0.5 + 26
                if g > limit:
                    g = int(limit)
            opx[x, y] = (r, g, b, a)
    return out


def autocrop_alpha(img, pad=10):
    a = img.getchannel('A')
    mask = a.point(lambda v: 255 if v > 10 else 0)
    bbox = mask.getbbox()
    if not bbox:
        return img
    x0, y0, x1, y1 = bbox
    x0 = max(0, x0 - pad); y0 = max(0, y0 - pad)
    x1 = min(img.width, x1 + pad); y1 = min(img.height, y1 + pad)
    return img.crop((x0, y0, x1, y1))


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    indir, outdir = sys.argv[1], sys.argv[2]
    thresh = float(sys.argv[3]) if len(sys.argv) > 3 else 0.28
    os.makedirs(outdir, exist_ok=True)
    for name in sorted(os.listdir(indir)):
        if not name.lower().endswith('.png'):
            continue
        src = os.path.join(indir, name)
        dst = os.path.join(outdir, name)
        im = Image.open(src).convert('RGB')
        out = autocrop_alpha(chromakey(im, thresh))
        out.save(dst)
        print(f'{name} -> {out.size[0]}x{out.size[1]}  {dst}')


if __name__ == '__main__':
    main()
