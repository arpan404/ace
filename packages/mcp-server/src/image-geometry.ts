export const modelImageMaxDimension = 1536;
/** Input scale is pixels per target point; output scale preserves that coordinate mapping. */
export function modelImageGeometry(width: number, height: number, scale = 1) {
  const factor = Math.min(1, modelImageMaxDimension / Math.max(width, height));
  const outputWidth = Math.max(1, Math.floor(width * factor));
  return {
    width: outputWidth,
    height: Math.max(1, Math.floor(height * factor)),
    scale: (scale * outputWidth) / width,
  };
}
