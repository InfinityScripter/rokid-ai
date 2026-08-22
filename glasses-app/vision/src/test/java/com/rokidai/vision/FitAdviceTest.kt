package com.rokidai.vision

import org.junit.Assert.assertEquals
import org.junit.Test

class FitAdviceTest {

    @Test
    fun `чётко обоими глазами — подгонка не нужна`() {
        val advice = adviceFor(leftSharp = true, rightSharp = true, doubles = false, higherHelps = false)
        assertEquals(FitAdvice.OK, advice)
    }

    @Test
    fun `нечётко одним глазом — это не посадка, а фокус`() {
        assertEquals(
            FitAdvice.FOCUS,
            adviceFor(leftSharp = false, rightSharp = true, doubles = true, higherHelps = false),
        )
        assertEquals(
            FitAdvice.FOCUS,
            adviceFor(leftSharp = true, rightSharp = false, doubles = false, higherHelps = false),
        )
    }

    @Test
    fun `нечётко обоими глазами — тоже фокус, а не сведение картинок`() {
        assertEquals(
            FitAdvice.FOCUS,
            adviceFor(leftSharp = false, rightSharp = false, doubles = true, higherHelps = true),
        )
    }

    @Test
    fun `каждым глазом чётко, вместе двоится, подъём помогает — дело в посадке`() {
        assertEquals(
            FitAdvice.SEATING,
            adviceFor(leftSharp = true, rightSharp = true, doubles = true, higherHelps = true),
        )
    }

    @Test
    fun `каждым глазом чётко, вместе двоится, подъём не помогает — проверять очки и глаза`() {
        assertEquals(
            FitAdvice.ALIGNMENT,
            adviceFor(leftSharp = true, rightSharp = true, doubles = true, higherHelps = false),
        )
    }

    // Крайний случай: по отдельности чётко и вместе не двоится, но человек
    // всё же дошёл до шага с подъёмом — считаем, что всё в порядке.
    @Test
    fun `не двоится — подъём роли не играет`() {
        assertEquals(
            FitAdvice.OK,
            adviceFor(leftSharp = true, rightSharp = true, doubles = false, higherHelps = true),
        )
    }

    @Test
    fun `у каждого вердикта есть заголовок и совет`() {
        for (advice in FitAdvice.entries) {
            assert(advice.title.isNotBlank()) { "нет заголовка у $advice" }
            assert(advice.text.isNotBlank()) { "нет совета у $advice" }
        }
    }
}
