/**
 * pdfjs 在 Node 环境的 DOM polyfill。
 *
 * pdfjs-dist 的 legacy/build/pdf.mjs 顶层会执行 `new DOMMatrix()`，
 * 纯 Node 环境没有 DOMMatrix/Path2D，需要 polyfill。
 * （文本提取不需要真正的矩阵运算，提供最小实现即可。）
 */

/* 仅在缺少时注入全局 DOMMatrix */
if (!(globalThis as Record<string, unknown>).DOMMatrix) {
  class MinimalDOMMatrix {
    private m: number[];
    constructor(init?: string | number[]) {
      if (typeof init === 'string') {
        this.m = init.split(',').map(Number);
      } else if (Array.isArray(init)) {
        this.m = [...init];
      } else {
        this.m = [1, 0, 0, 1, 0, 0];
      }
    }
    multiplySelf() {
      return this;
    }
    translate() {
      return this;
    }
    scale() {
      return this;
    }
    rotate() {
      return this;
    }
    skewX() {
      return this;
    }
    skewY() {
      return this;
    }
    flipX() {
      return this;
    }
    flipY() {
      return this;
    }
    inverse() {
      return this;
    }
    transformPoint(p: { x: number; y: number }) {
      return { x: p.x, y: p.y };
    }
    get a() {
      return this.m[0];
    }
    set a(v) {
      this.m[0] = v;
    }
    get b() {
      return this.m[1];
    }
    set b(v) {
      this.m[1] = v;
    }
    get c() {
      return this.m[2];
    }
    set c(v) {
      this.m[2] = v;
    }
    get d() {
      return this.m[3];
    }
    set d(v) {
      this.m[3] = v;
    }
    get e() {
      return this.m[4];
    }
    set e(v) {
      this.m[4] = v;
    }
    get f() {
      return this.m[5];
    }
    set f(v) {
      this.m[5] = v;
    }
  }
  (globalThis as Record<string, unknown>).DOMMatrix = MinimalDOMMatrix;
}

/* Path2D polyfill（文本提取用不到，空实现即可） */
if (!(globalThis as Record<string, unknown>).Path2D) {
  class MinimalPath2D {
    moveTo() {}
    lineTo() {}
    bezierCurveTo() {}
    quadraticCurveTo() {}
    arc() {}
    closePath() {}
    rect() {}
  }
  (globalThis as Record<string, unknown>).Path2D = MinimalPath2D;
}
