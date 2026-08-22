package com.rokidai.vision

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.view.View

// Мишень для проверки: крест с рисками и кольцом. Тонкие длинные линии выбраны
// нарочно — на них смещение второй картинки видно сразу и понятно, куда она
// уехала: вбок или вверх. На сплошной надписи это не разглядеть.
class TargetView(context: Context) : View(context) {

    private val line = Paint().apply {
        color = 0xFF45F068.toInt()
        style = Paint.Style.STROKE
        strokeWidth = 2f
        isAntiAlias = true
    }
    private val dot = Paint().apply {
        color = 0xFF45F068.toInt()
        style = Paint.Style.FILL
        isAntiAlias = true
    }

    override fun onDraw(canvas: Canvas) {
        val cx = width / 2f
        val cy = height / 2f
        // По вертикали место ограничено верхней половиной экрана, а вширь его
        // много — поэтому крест шире, чем выше: боковое смещение видно лучше.
        val armX = width / 2f - 6f
        val armY = height / 2f - 6f
        if (armX <= 0 || armY <= 0) return

        canvas.drawLine(cx - armX, cy, cx + armX, cy, line)
        canvas.drawLine(cx, cy - armY, cx, cy + armY, line)
        canvas.drawCircle(cx, cy, armY * 0.5f, line)

        // Риски через каждые 20 пикселей: по ним видно, на сколько именно
        // разъезжаются две картинки, а не только сам факт двоения.
        var offset = 20f
        while (offset < armX) {
            canvas.drawLine(cx - offset, cy - 5f, cx - offset, cy + 5f, line)
            canvas.drawLine(cx + offset, cy - 5f, cx + offset, cy + 5f, line)
            offset += 20f
        }
        offset = 20f
        while (offset < armY) {
            canvas.drawLine(cx - 5f, cy - offset, cx + 5f, cy - offset, line)
            canvas.drawLine(cx - 5f, cy + offset, cx + 5f, cy + offset, line)
            offset += 20f
        }

        canvas.drawCircle(cx, cy, 3f, dot)
    }
}
