/**
 * The installed kernels by identity, with each kernel's code as its own on-demand module (`KernelSource` of
 * `serveModelWorker`). The catalogue worker serves these: a worker fetches only the code of the kernels its requests
 * name, and kernel code is never loaded outside the worker. New activity packages add their kernel here and to
 * ./index.ts; tests/catalog/lazy.test.ts checks that both lists name the same kernels.
 */
import type { KernelSource } from '@experiment-kit/core/model';

export const INSTALLED_KERNEL_SOURCE: KernelSource = Object.freeze({
  kernels: Object.freeze([
    Object.freeze({ id: 'quadratic-gradient-descent', version: '1.0.0', mode: 'discrete' as const }),
    Object.freeze({ id: 'function-derivative', version: '1.0.0', mode: 'static' as const }),
    Object.freeze({ id: 'linear-transformation', version: '1.0.0', mode: 'static' as const }),
    Object.freeze({ id: 'vector-orientation-3d', version: '1.0.0', mode: 'static' as const }),
    Object.freeze({ id: 'quadratic-surface-gradient', version: '1.1.0', mode: 'static' as const }),
  ]),
  async load(id: string, version: string) {
    switch (`${id}@${version}`) {
      case 'quadratic-gradient-descent@1.0.0': return (await import('./quadratic-gradient-descent.js')).quadraticGradientDescentKernel;
      case 'function-derivative@1.0.0': return (await import('./function-derivative.js')).functionDerivativeKernel;
      case 'linear-transformation@1.0.0': return (await import('./linear-transformation.js')).linearTransformationKernel;
      case 'vector-orientation-3d@1.0.0': return (await import('./vector-orientation-3d.js')).vectorOrientationKernel;
      case 'quadratic-surface-gradient@1.1.0': return (await import('./quadratic-surface-gradient.js')).quadraticSurfaceGradientKernel;
      default: throw new RangeError('The kernel is not installed.');
    }
  },
});
