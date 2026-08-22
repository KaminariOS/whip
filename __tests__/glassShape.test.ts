import { liquidGlassShapeStyle } from '../src/components/glassShape';

describe('liquid glass shape', () => {
  test('matches the application radius tokens', () => {
    expect(liquidGlassShapeStyle('rounded-lg border')).toEqual({ borderRadius: 16 });
    expect(liquidGlassShapeStyle('rounded-md border')).toEqual({ borderRadius: 12 });
    expect(liquidGlassShapeStyle('rounded-xl border')).toEqual({ borderRadius: 12 });
    expect(liquidGlassShapeStyle('rounded-full border')).toEqual({ borderRadius: 9999 });
  });

  test('preserves arbitrary full and top-only radii', () => {
    expect(liquidGlassShapeStyle('rounded-[20px]')).toEqual({ borderRadius: 20 });
    expect(liquidGlassShapeStyle('rounded-t-[28px]')).toEqual({
      borderTopLeftRadius: 28,
      borderTopRightRadius: 28,
    });
  });

  test('leaves square surfaces unchanged', () => {
    expect(liquidGlassShapeStyle('border-b')).toBeUndefined();
  });
});
