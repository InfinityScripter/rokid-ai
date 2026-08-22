package com.rokidai.vision

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FitWizardTest {

    @Test
    fun `мастер начинается с чистки линз`() {
        assertEquals(FitStep.CLEAN, FitWizard().step)
    }

    @Test
    fun `двоения нет — шаг с подъёмом очков пропускается`() {
        val wizard = FitWizard()
        assertFalse(wizard.answer(yes = true))   // линзы протёр
        assertEquals(FitStep.LEFT, wizard.step)
        assertFalse(wizard.answer(yes = true))   // левым чётко
        assertFalse(wizard.answer(yes = true))   // правым чётко
        assertTrue(wizard.answer(yes = false))   // не двоится — мастер закончен
        assertEquals(FitAdvice.OK, wizard.advice())
    }

    @Test
    fun `двоится и подъём помог — вердикт про посадку`() {
        val wizard = FitWizard()
        wizard.answer(yes = true)
        wizard.answer(yes = true)
        wizard.answer(yes = true)
        assertFalse(wizard.answer(yes = true))   // двоится — идём к подъёму
        assertEquals(FitStep.HIGHER, wizard.step)
        assertTrue(wizard.answer(yes = true))    // подъём помог
        assertEquals(FitAdvice.SEATING, wizard.advice())
    }

    @Test
    fun `нечёткость одним глазом доводит мастер до конца и даёт вердикт про фокус`() {
        val wizard = FitWizard()
        wizard.answer(yes = true)
        wizard.answer(yes = false)               // левым нечётко
        wizard.answer(yes = true)
        wizard.answer(yes = true)                // двоится
        wizard.answer(yes = false)               // подъём не помог
        assertEquals(FitAdvice.FOCUS, wizard.advice())
    }

    @Test
    fun `после сброса мастер снова на первом шаге`() {
        val wizard = FitWizard()
        wizard.answer(yes = true)
        wizard.answer(yes = true)
        wizard.reset()
        assertEquals(FitStep.CLEAN, wizard.step)
    }

    @Test
    fun `у каждого шага есть заголовок и подсказка`() {
        for (step in FitStep.entries) {
            assertTrue("нет заголовка у $step", step.title.isNotBlank())
            assertTrue("нет подсказки у $step", step.hint.isNotBlank())
        }
    }
}
