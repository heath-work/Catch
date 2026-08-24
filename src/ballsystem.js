/* =====================================================================
   ballsystem.js — the ONLY seam onto the shipped ball renderer.

   Catch to Pick reuses the exact ball treatment from the BallPark
   visualiser (tetra4 stamps, matcap, product palettes, #050541) via
   assets/ball-core.js. That bundle exposes its internals as
   single-letter ESM exports; this module renames them to something
   legible and re-exports. Nothing else in the app touches the raw
   bundle, so if the export letters ever change this is the one file
   to fix.

   Letter map (recovered from the shipped ballSpinner.js loader and
   verified against assets/ball-core.js):
     f createBallRenderer   m getPattern        d paletteFor
     u colourFor            y makeMatcapTexture P Quaternion
     z Vector3              A MeshMatcapMaterial L SphereGeometry
     O Mesh                 F SRGBColorSpace    S WebGLRenderer
     I Scene                j OrthographicCamera
   ===================================================================== */
export {
  f as createBallRenderer,   // (renderer) -> { createBallMesh(number, radius, colour, pattern), dispose() }
  m as getPattern,           // (id) -> { id, label, stamps, sizing, matcap, baseRotation, note }
  d as paletteFor,           // (product) -> palette
  u as colourFor,            // (palette, number, isBonus) -> { ballColor, glyphColor }
  P as Quaternion,
  z as Vector3,
  L as SphereGeometry,
  O as Mesh,
  S as WebGLRenderer,
  I as Scene,
  j as OrthographicCamera,
} from '../assets/ball-core.js';

import { m as _getPattern } from '../assets/ball-core.js';

/* The visualiser's approved tetrahedron treatment: four number stamps
   arranged on a tetrahedron so a number always faces the camera as the
   ball rolls, with no blind axis. The whole experience is locked to it.
   Its four product palettes (multi / oz / sfl / powerball) are the four
   approved tetrahedron ball variations and are resolved per-product by
   paletteFor(). */
export const TETRA4 = _getPattern('tetra4');

/* The exact indigo the visualiser clears to. Lives next to the renderer
   it belongs to. */
export const BG_INDIGO = 0x050541;
export const BG_INDIGO_CSS = '#050541';
