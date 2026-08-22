package com.rokidai.vats

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface

// Отрисовщик худа VATS — язык согласован по эталону Fallout 4 (прототип vats2.html,
// слепой суд 2026-08-22). Один код рисует и на дисплей очков, и в кадр видеозаписи:
// поверхности отличаются только мапперами координат и масштабом.
object VatsDraw {

    const val GREEN = 0xFF26E75B.toInt()
    private const val DARK = 0xFF08210F.toInt()
    private const val RED = 0xFFE8542F.toInt()
    private const val RED_LIGHT = 0xFFFFB59E.toInt()

    val PART_ORDER = listOf("ГОЛОВА", "ТОРС", "РУКИ", "НОГИ")

    class Target(
        val person: VatsPerson,
        val partPct: Map<String, Int>,
        val capture: Float, // 0..1 анимация захвата
        val selectedPart: String?, // только у цели в фокусе
    )

    private val fill = Paint().apply { isAntiAlias = true }
    private val stroke = Paint().apply { style = Paint.Style.STROKE; isAntiAlias = true }
    private val text = Paint().apply { typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD); isAntiAlias = true }

    fun partBoxOf(p: VatsPerson, name: String): VatsBox? = when (name) {
        "ГОЛОВА" -> p.head
        "ТОРС" -> p.torso
        "РУКИ" -> p.arms
        else -> p.legs
    }

    // Рисует весь худ. mapX/mapY переводят нормализованные координаты кадра
    // камеры в пиксели поверхности.
    fun draw(
        canvas: Canvas,
        w: Float,
        h: Float,
        targets: List<Target>,
        game: VatsGame,
        now: Long,
        recording: Boolean,
        mapX: (Float) -> Float,
        mapY: (Float) -> Float,
    ) {
        val s = h / 720f // масштаб типографики относительно макета прототипа

        crosshair(canvas, w, h, s)

        var focus: Target? = null
        targets.forEach { t ->
            val ease = 1f - (1f - t.capture) * (1f - t.capture) * (1f - t.capture)
            if (t.selectedPart != null) focus = t
            PART_ORDER.forEach parts@{ part ->
                val box = partBoxOf(t.person, part) ?: return@parts
                val pct = t.partPct[part] ?: return@parts
                // при захвате плашки слетаются от краёв к своим местам
                val i = PART_ORDER.indexOf(part)
                val tx = mapX(box.cx) + (1 - ease) * (if (i % 2 == 0) -w * 0.4f else w * 0.4f)
                val ty = mapY(box.y) + (1 - ease) * (if (i < 2) -h * 0.3f else h * 0.3f)
                val shown = (pct * ease).toInt()
                if (part == t.selectedPart && t.capture >= 1f) {
                    selectedPanel(canvas, mapX(box.cx), mapY(box.cy), part, shown, s)
                } else {
                    chip(canvas, tx, ty, shown.toString(), s)
                }
            }
        }

        focus?.let { banner(canvas, w, "ЧЕЛОВЕК-1 ★", s) }
        bars(canvas, w, h, game, s, recording)
        game.verdict(now)?.let { (label, ok) -> stamp(canvas, w, h, label, ok, s) }
    }

    private fun crosshair(canvas: Canvas, w: Float, h: Float, s: Float) {
        stroke.color = GREEN; stroke.strokeWidth = 2f * s
        val cx = w / 2; val cy = h / 2; val a = 20 * s; val b = 6 * s
        canvas.drawLines(
            floatArrayOf(cx - a, cy, cx - b, cy, cx + b, cy, cx + a, cy, cx, cy - a, cx, cy - b, cx, cy + b, cx, cy + a),
            stroke,
        )
    }

    private fun corners(canvas: Canvas, x: Float, y: Float, w: Float, h: Float, len: Float, off: Float) {
        val pts = ArrayList<Float>(48)
        for ((px, py, dx, dy) in listOf(
                Quad(x - off, y - off, 1f, 1f), Quad(x + w + off, y - off, -1f, 1f),
                Quad(x - off, y + h + off, 1f, -1f), Quad(x + w + off, y + h + off, -1f, -1f),
            )) {
            pts.addAll(listOf(px + dx * len, py, px, py, px, py, px, py + dy * len))
        }
        canvas.drawLines(pts.toFloatArray(), stroke)
    }

    private data class Quad(val x: Float, val y: Float, val dx: Float, val dy: Float)

    private fun chip(canvas: Canvas, cx: Float, cy: Float, label: String, s: Float) {
        text.textSize = 24 * s
        val w = text.measureText(label) + 30 * s
        val h = 36 * s
        val x = cx - w / 2; val y = cy - h / 2
        fill.color = GREEN
        canvas.drawRect(x, y, x + w, y + h, fill)
        stroke.color = GREEN; stroke.strokeWidth = 2f * s
        corners(canvas, x, y, w, h, 8 * s, 5 * s)
        text.color = DARK
        canvas.drawText(label, x + 15 * s, y + h - 10 * s, text)
    }

    private fun selectedPanel(canvas: Canvas, cx: Float, cy: Float, part: String, pct: Int, s: Float) {
        text.textSize = 24 * s
        val w = maxOf(text.measureText(part), 110 * s) + 28 * s
        val h = 92 * s
        val x = cx - w / 2; val y = cy - h / 2
        fill.color = 0xE026E75B.toInt() // слегка полупрозрачная заливка
        canvas.drawRect(x, y, x + w, y + h, fill)
        stroke.color = GREEN; stroke.strokeWidth = 3f * s
        corners(canvas, x, y, w, h, 12 * s, 7 * s)
        text.color = DARK
        canvas.drawText(part, x + 14 * s, y + 28 * s, text)
        fill.color = DARK
        canvas.drawRect(x + 14 * s, y + 38 * s, x + 14 * s + (w - 28 * s) * 0.66f, y + 47 * s, fill)
        stroke.color = DARK; stroke.strokeWidth = 2f * s
        canvas.drawRect(x + 14 * s, y + 38 * s, x + w - 14 * s, y + 47 * s, stroke)
        text.textSize = 38 * s
        val num = pct.toString()
        canvas.drawText(num, x + 14 * s, y + 84 * s, text)
        val nw = text.measureText(num)
        corners(canvas, x + 14 * s, y + 52 * s, nw, 34 * s, 7 * s, 4 * s)
    }

    private fun banner(canvas: Canvas, w: Float, name: String, s: Float) {
        text.textSize = 34 * s; text.color = RED
        val tw = text.measureText(name)
        canvas.drawText(name, w / 2 - tw / 2, 58 * s, text)
        fill.color = RED
        canvas.drawRect(w / 2 - tw / 2, 68 * s, w / 2 + tw / 2, 77 * s, fill)
        fill.color = RED_LIGHT
        canvas.drawRect(w / 2 - tw / 2, 68 * s, w / 2 - tw / 2 + tw * 0.22f, 77 * s, fill)
        text.textSize = 20 * s
        val sub = "УРОВЕНЬ 9  Щ 10  ЭН 10  РАД 10"
        val sw = text.measureText(sub) + 48 * s
        val sx = w / 2 - sw / 2; val sy = 82 * s
        stroke.color = RED; stroke.strokeWidth = 3f * s
        canvas.drawLines(
            floatArrayOf(
                sx + 10 * s, sy, sx, sy, sx, sy, sx, sy + 30 * s, sx, sy + 30 * s, sx + 10 * s, sy + 30 * s,
                sx + sw - 10 * s, sy, sx + sw, sy, sx + sw, sy, sx + sw, sy + 30 * s, sx + sw, sy + 30 * s, sx + sw - 10 * s, sy + 30 * s,
            ),
            stroke,
        )
        canvas.drawText(sub, sx + 24 * s, sy + 22 * s, text)
    }

    private fun bars(canvas: Canvas, w: Float, h: Float, game: VatsGame, s: Float, recording: Boolean) {
        stroke.color = GREEN; stroke.strokeWidth = 2f * s
        text.color = GREEN; text.textSize = 22 * s
        // КРИТ с засечкой
        canvas.drawText("КРИТ", w / 2 - 260 * s, h - 118 * s, text)
        canvas.drawRect(w / 2 - 190 * s, h - 138 * s, w / 2 + 190 * s, h - 114 * s, stroke)
        fill.color = GREEN
        canvas.drawRect(w / 2 - 187 * s, h - 135 * s, w / 2 - 187 * s + 377 * s * game.crit, h - 117 * s, fill)
        canvas.drawRect(w / 2 + 63 * s, h - 144 * s, w / 2 + 66 * s, h - 108 * s, fill)
        // ЗДР слева, ОД справа
        canvas.drawText("ЗДР", 24 * s, h - 60 * s, text)
        canvas.drawRect(84 * s, h - 76 * s, 344 * s, h - 58 * s, stroke)
        canvas.drawRect(86 * s, h - 74 * s, 86 * s + 256 * s * 0.8f, h - 60 * s, fill)
        val apX = w - 324 * s; val apW = 260 * s
        canvas.drawText("ОД", w - 58 * s, h - 60 * s, text)
        canvas.drawRect(apX, h - 76 * s, apX + apW, h - 58 * s, stroke)
        canvas.drawRect(apX + 2 * s, h - 74 * s, apX + 2 * s + (apW - 4 * s) * game.ap / VatsGame.AP_MAX, h - 60 * s, fill)
        canvas.drawLines(
            floatArrayOf(apX - 6 * s, h - 82 * s, apX - 6 * s, h - 52 * s, apX + apW + 6 * s, h - 82 * s, apX + apW + 6 * s, h - 52 * s),
            stroke,
        )
        // подсказки в скобках
        text.textSize = 19 * s
        val hints = listOf("К" to "ВЫСТРЕЛ", "З" to if (recording) "СТОП ЗАПИСИ" else "ЗАПИСЬ", "Н" to "ВЫХОД")
        var total = 0f
        hints.forEach { (_, t) -> total += 46 * s + text.measureText(t) + 26 * s }
        var hx = w / 2 - total / 2
        stroke.strokeWidth = 3f * s
        canvas.drawLines(
            floatArrayOf(
                hx - 16 * s, h - 40 * s, hx - 26 * s, h - 40 * s, hx - 26 * s, h - 40 * s, hx - 26 * s, h - 8 * s, hx - 26 * s, h - 8 * s, hx - 16 * s, h - 8 * s,
                hx + total + 2 * s, h - 40 * s, hx + total + 12 * s, h - 40 * s, hx + total + 12 * s, h - 40 * s, hx + total + 12 * s, h - 8 * s, hx + total + 12 * s, h - 8 * s, hx + total + 2 * s, h - 8 * s,
            ),
            stroke,
        )
        stroke.strokeWidth = 2f * s
        hints.forEach { (k, t) ->
            canvas.drawCircle(hx + 15 * s, h - 24 * s, 13 * s, stroke)
            canvas.drawText(k, hx + 9 * s, h - 17 * s, text)
            canvas.drawText(t, hx + 38 * s, h - 17 * s, text)
            hx += 46 * s + text.measureText(t) + 26 * s
        }
        if (recording) {
            fill.color = RED
            canvas.drawCircle(w - 30 * s, 30 * s, 10 * s, fill)
        }
    }

    private fun stamp(canvas: Canvas, w: Float, h: Float, label: String, ok: Boolean, s: Float) {
        text.textSize = 64 * s
        text.color = if (ok) GREEN else RED
        val tw = text.measureText(label)
        canvas.drawText(label, w / 2 - tw / 2, h * 0.42f, text)
        text.color = GREEN
    }
}
