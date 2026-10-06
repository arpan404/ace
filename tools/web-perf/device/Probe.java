package dev.ace.perf;

import android.app.Activity;
import android.os.Bundle;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Color;
import android.view.View;
import android.view.MotionEvent;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.BaseInputConnection;

// Owned disposable app, with the same on-screen clock and acknowledgement as the iOS probe.
public final class Probe extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(new Clock());
    }
    final class Clock extends View {
        final Paint paint = new Paint();
        boolean ack;
        boolean moving;
        float startX;
        Clock() { super(Probe.this); setFocusableInTouchMode(true); requestFocus(); }
        void acknowledge() { ack = !ack; invalidate(); }
        @Override public boolean onTouchEvent(MotionEvent event) {
            if (event.getAction() == MotionEvent.ACTION_DOWN) {
                startX = event.getX(); moving = false;
            } else if (event.getAction() == MotionEvent.ACTION_MOVE && !moving && Math.abs(event.getX() - startX) > 10) {
                moving = true; acknowledge();
            } else if (event.getAction() == MotionEvent.ACTION_UP && !moving) {
                acknowledge(); requestFocus();
            }
            return true;
        }
        @Override public boolean onCheckIsTextEditor() { return true; }
        @Override public InputConnection onCreateInputConnection(EditorInfo info) {
            info.inputType = 1;
            return new BaseInputConnection(this, false) {
                @Override public boolean commitText(CharSequence text, int position) { acknowledge(); return true; }
                @Override public boolean sendKeyEvent(android.view.KeyEvent event) {
                    if (event.getAction() == android.view.KeyEvent.ACTION_DOWN) acknowledge();
                    return true;
                }
            };
        }
        @Override public boolean onKeyDown(int keyCode, android.view.KeyEvent event) { acknowledge(); return true; }
        void cell(Canvas canvas, int color, float x, float y, float width) {
            paint.setColor(color); canvas.drawRect(x, y, x + width, y + width * 3, paint);
        }
        @Override protected void onDraw(Canvas canvas) {
            canvas.drawColor(Color.DKGRAY);
            long time = System.currentTimeMillis() & 0xffffffffL;
            float width = getWidth() / 40f, y = getHeight() / 2f;
            cell(canvas, Color.RED, width * 3, y, width);
            for (int bit = 0; bit < 32; bit++) cell(canvas, ((time >> bit) & 1) == 1 ? Color.WHITE : Color.BLACK, width * (bit + 4), y, width);
            cell(canvas, ack ? Color.GREEN : Color.BLUE, width * 36, y, width);
            postInvalidateOnAnimation();
        }
    }
}
