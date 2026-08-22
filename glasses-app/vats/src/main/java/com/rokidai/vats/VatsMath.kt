package com.rokidai.vats

// Чистая математика VATS-режима: разбор выхода MoveNet MultiPose и игровой
// «процент попадания». Координаты везде нормализованные (0..1 от кадра камеры),
// на экран их переводит VatsHudView.

data class VatsBox(val x: Float, val y: Float, val w: Float, val h: Float) {
    val cx get() = x + w / 2
    val cy get() = y + h / 2
}

data class VatsPerson(
    val box: VatsBox,
    val head: VatsBox?,
    val torso: VatsBox?,
    val arms: VatsBox?,
    val legs: VatsBox?,
)

object VatsMath {
    const val KEYPOINTS = 17
    const val PERSON_STRIDE = 56 // 17*(y,x,score) + ymin,xmin,ymax,xmax,score

    private const val PART_MIN_SCORE = 0.3f
    private const val PAD = 0.02f

    // Индексы точек MoveNet: 0 nose, 1-4 глаза/уши, 5-6 плечи, 7-10 локти/кисти,
    // 11-12 бёдра, 13-16 колени/лодыжки.
    private val HEAD = intArrayOf(0, 1, 2, 3, 4)
    private val TORSO = intArrayOf(5, 6, 11, 12)
    private val ARMS = intArrayOf(7, 8, 9, 10)
    private val LEGS = intArrayOf(13, 14, 15, 16)

    fun decode(out: FloatArray, minScore: Float = 0.25f): List<VatsPerson> {
        val people = mutableListOf<VatsPerson>()
        for (p in 0 until out.size / PERSON_STRIDE) {
            val base = p * PERSON_STRIDE
            if (out[base + 55] < minScore) continue
            val box = VatsBox(
                x = out[base + 52],
                y = out[base + 51],
                w = out[base + 54] - out[base + 52],
                h = out[base + 53] - out[base + 51],
            )
            people += VatsPerson(
                box = box,
                head = partBox(out, base, HEAD),
                torso = partBox(out, base, TORSO),
                arms = partBox(out, base, ARMS),
                legs = partBox(out, base, LEGS),
            )
        }
        return people
    }

    private fun partBox(out: FloatArray, base: Int, indices: IntArray): VatsBox? {
        var minX = 1f; var minY = 1f; var maxX = 0f; var maxY = 0f
        var count = 0
        for (i in indices) {
            if (out[base + i * 3 + 2] < PART_MIN_SCORE) continue
            val y = out[base + i * 3]
            val x = out[base + i * 3 + 1]
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
            count++
        }
        if (count < 2) return null
        return VatsBox(minX - PAD, minY - PAD, maxX - minX + PAD * 2, maxY - minY + PAD * 2)
    }

    // Максимальная уверенность модели по всем слотам, включая отброшенные —
    // для диагностики «модель вообще что-то видит?».
    fun maxRawScore(out: FloatArray): Float {
        var max = 0f
        for (p in 0 until out.size / PERSON_STRIDE) {
            val s = out[p * PERSON_STRIDE + 55]
            if (s > max) max = s
        }
        return max
    }

    // Ближе (крупнее бокс) — выше; дальше от центра прицела — ниже; движется —
    // ниже. Формула игровая, перенесена из прототипа как есть.
    fun hitChance(box: VatsBox, vel: Float, partFactor: Float): Int {
        val size = minOf(1f, box.h)
        val off = minOf(1f, kotlin.math.hypot(box.cx - 0.5f, box.cy - 0.5f) / 0.6f)
        val motion = minOf(1f, vel / 0.05f)
        val p = (0.35f + 0.6f * size) * (1 - 0.35f * off) * (1 - 0.3f * motion) * partFactor
        return (p * 100).toInt().coerceIn(3, 95)
    }
}
