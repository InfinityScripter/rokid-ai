package com.rokidai.vats

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VatsMathTest {

    // Собирает тензор MoveNet на одного человека: 17 точек (y,x,score) + бокс.
    private fun personTensor(
        cx: Float,
        cy: Float,
        h: Float,
        score: Float,
    ): FloatArray {
        val t = FloatArray(VatsMath.PERSON_STRIDE)
        // Точки раскладываем столбиком: голова сверху, лодыжки снизу.
        for (i in 0 until VatsMath.KEYPOINTS) {
            val frac = i / (VatsMath.KEYPOINTS - 1f)
            t[i * 3] = cy - h / 2 + h * frac // y
            t[i * 3 + 1] = cx // x
            t[i * 3 + 2] = score
        }
        t[51] = cy - h / 2 // ymin
        t[52] = cx - 0.05f // xmin
        t[53] = cy + h / 2 // ymax
        t[54] = cx + 0.05f // xmax
        t[55] = score
        return t
    }

    private fun fullTensor(vararg persons: FloatArray): FloatArray {
        val out = FloatArray(6 * VatsMath.PERSON_STRIDE)
        persons.forEachIndexed { i, p -> p.copyInto(out, i * VatsMath.PERSON_STRIDE) }
        return out
    }

    @Test
    fun `decode находит человека и все четыре части тела`() {
        val people = VatsMath.decode(fullTensor(personTensor(0.5f, 0.5f, 0.6f, 0.9f)))
        assertEquals(1, people.size)
        val p = people[0]
        assertTrue(p.box.h in 0.5f..0.8f)
        listOf(p.head, p.torso, p.arms, p.legs).forEach { part ->
            assertTrue(part != null && part.w > 0 && part.h > 0)
        }
        // Голова выше ног.
        assertTrue(p.head!!.y < p.legs!!.y)
    }

    @Test
    fun `decode отбрасывает людей с низким score`() {
        val people = VatsMath.decode(
            fullTensor(
                personTensor(0.3f, 0.5f, 0.6f, 0.9f),
                personTensor(0.7f, 0.5f, 0.6f, 0.1f),
            ),
        )
        assertEquals(1, people.size)
    }

    @Test
    fun `часть тела без уверенных точек отсутствует`() {
        val t = personTensor(0.5f, 0.5f, 0.6f, 0.9f)
        // Гасим уверенность точек ног (индексы 13..16).
        for (i in 13..16) t[i * 3 + 2] = 0.05f
        val p = VatsMath.decode(fullTensor(t))[0]
        assertNull(p.legs)
    }

    @Test
    fun `процент растёт когда цель ближе (крупнее)`() {
        val far = VatsMath.hitChance(VatsBox(0.45f, 0.4f, 0.1f, 0.2f), vel = 0f, partFactor = 1f)
        val near = VatsMath.hitChance(VatsBox(0.35f, 0.2f, 0.3f, 0.6f), vel = 0f, partFactor = 1f)
        assertTrue("near=$near far=$far", near > far)
    }

    @Test
    fun `процент падает от движения и от смещения с прицела`() {
        val still = VatsMath.hitChance(VatsBox(0.35f, 0.2f, 0.3f, 0.6f), vel = 0f, partFactor = 1f)
        val moving = VatsMath.hitChance(VatsBox(0.35f, 0.2f, 0.3f, 0.6f), vel = 0.1f, partFactor = 1f)
        val offCenter = VatsMath.hitChance(VatsBox(0.0f, 0.0f, 0.3f, 0.6f), vel = 0f, partFactor = 1f)
        assertTrue(moving < still)
        assertTrue(offCenter < still)
    }

    @Test
    fun `процент всегда в пределах 3-95`() {
        val min = VatsMath.hitChance(VatsBox(0f, 0f, 0.01f, 0.01f), vel = 1f, partFactor = 0.1f)
        val max = VatsMath.hitChance(VatsBox(0.25f, 0f, 0.5f, 1f), vel = 0f, partFactor = 5f)
        assertTrue(min >= 3)
        assertTrue(max <= 95)
    }
}
