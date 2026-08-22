package com.rokidai.vats

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VatsGameTest {

    @Test
    fun `выстрел тратит 3 ОД и даёт вердикт`() {
        val g = VatsGame(rng = { 0.0f }) // всегда попадание
        val hit = g.shoot(now = 1000, chancePct = 50)
        assertEquals(true, hit)
        assertEquals(VatsGame.AP_MAX - 3, g.ap)
        assertEquals("ПОПАЛ" to true, g.verdict(now = 1500))
    }

    @Test
    fun `вердикт исчезает по таймеру`() {
        val g = VatsGame(rng = { 0.0f })
        g.shoot(now = 1000, chancePct = 90)
        assertNull(g.verdict(now = 1000 + VatsGame.VERDICT_MS + 1))
    }

    @Test
    fun `промах при неудачном броске`() {
        val g = VatsGame(rng = { 0.99f })
        assertEquals(false, g.shoot(now = 0, chancePct = 50))
        assertEquals("ПРОМАХ" to false, g.verdict(now = 100))
    }

    @Test
    fun `без ОД стрелять нельзя`() {
        val g = VatsGame(rng = { 0.0f })
        g.shoot(0, 90); g.shoot(0, 90); g.shoot(0, 90) // 9 - 9 = 0
        assertEquals(0, g.ap)
        assertNull(g.shoot(0, 90))
    }

    @Test
    fun `ОД восстанавливается по одному за интервал`() {
        val g = VatsGame(rng = { 0.0f })
        g.shoot(now = 0, chancePct = 90)
        g.tick(now = VatsGame.AP_REGEN_MS - 1)
        assertEquals(VatsGame.AP_MAX - 3, g.ap)
        g.tick(now = VatsGame.AP_REGEN_MS)
        assertEquals(VatsGame.AP_MAX - 2, g.ap)
        g.tick(now = VatsGame.AP_REGEN_MS * 3)
        assertEquals(VatsGame.AP_MAX, g.ap)
        g.tick(now = VatsGame.AP_REGEN_MS * 10)
        assertEquals(VatsGame.AP_MAX, g.ap) // выше максимума не растёт
    }

    @Test
    fun `крит растёт и упирается в единицу`() {
        val g = VatsGame(rng = { 0.0f })
        val before = g.crit
        g.shoot(0, 90)
        assertTrue(g.crit > before)
        repeat(10) { g.tick(it * VatsGame.AP_REGEN_MS * 3); g.shoot(it * 10000L, 90) }
        assertTrue(g.crit <= 1f)
        assertFalse(g.crit.isNaN())
    }
}
