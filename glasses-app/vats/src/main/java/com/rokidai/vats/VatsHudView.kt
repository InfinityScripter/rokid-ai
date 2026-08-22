package com.rokidai.vats

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.view.View

// Дисплей очков: чёрный фон прозрачен, видна только графика худа.
// Вся отрисовка — в VatsDraw; здесь только маппинг координат и диагностика.
class VatsHudView(context: Context, private val game: VatsGame) : View(context) {

    @Volatile var targets: List<VatsDraw.Target> = emptyList()
    @Volatile var recording = false
    @Volatile var debugBitmap: Bitmap? = null
    @Volatile var debugText: String = ""
    @Volatile var showDebug = true

    // Сколько кадра камеры видно сквозь дисплей; живой худ не требует точности.
    var zoom = 1.8f

    private val text = Paint().apply {
        color = VatsDraw.GREEN
        textSize = 18f
        typeface = Typeface.MONOSPACE
        isAntiAlias = true
    }

    override fun onDraw(canvas: Canvas) {
        canvas.drawColor(Color.BLACK)
        VatsDraw.draw(
            canvas, width.toFloat(), height.toFloat(), targets, game,
            now = System.currentTimeMillis(), recording = recording,
            mapX = { nx -> width / 2f + (nx - 0.5f) * zoom * width },
            mapY = { ny -> height / 2f + (ny - 0.5f) * zoom * width * 0.75f },
        )
        if (showDebug) {
            debugBitmap?.let { canvas.drawBitmap(it, null, RectF(8f, 130f, 136f, 226f), null) }
            if (debugText.isNotEmpty()) canvas.drawText(debugText, 8f, 246f, text)
        }
        postInvalidateDelayed(50)
    }
}
