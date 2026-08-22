package com.rokidai.vision

// Шаги подгонки. Порядок повторяет официальный совет Rokid: сперва грязь на
// волноводах (разводы рассеивают свет и выглядят как двоение), потом проверка
// каждым глазом по отдельности и только затем — посадка на носу.
enum class FitStep(val title: String, val hint: String, val showTarget: Boolean) {
    CLEAN("ПРОТРИ ЛИНЗЫ", "сухой салфеткой\nклик — готово", false),
    LEFT("ЗАКРОЙ ЛЕВЫЙ ГЛАЗ", "крест чёткий?\nклик — да · назад — нет", true),
    RIGHT("ЗАКРОЙ ПРАВЫЙ ГЛАЗ", "крест чёткий?\nклик — да · назад — нет", true),
    BOTH("ОТКРОЙ ОБА ГЛАЗА", "крест двоится?\nклик — да · назад — нет", true),
    HIGHER("ПОДНИМИ ОЧКИ ВЫШЕ", "стало лучше?\nклик — да · назад — нет", true),
}

class FitWizard {

    var step: FitStep = FitStep.CLEAN
        private set

    private var leftSharp = true
    private var rightSharp = true
    private var doubles = false
    private var higherHelps = false

    /** Ответ на текущий шаг. Возвращает true, когда мастер закончен. */
    fun answer(yes: Boolean): Boolean {
        when (step) {
            FitStep.CLEAN -> step = FitStep.LEFT
            FitStep.LEFT -> {
                leftSharp = yes
                step = FitStep.RIGHT
            }
            FitStep.RIGHT -> {
                rightSharp = yes
                step = FitStep.BOTH
            }
            FitStep.BOTH -> {
                doubles = yes
                // Не двоится — спрашивать про подъём очков нечего.
                if (!yes) return true
                step = FitStep.HIGHER
            }
            FitStep.HIGHER -> {
                higherHelps = yes
                return true
            }
        }
        return false
    }

    fun advice(): FitAdvice = adviceFor(leftSharp, rightSharp, doubles, higherHelps)

    fun reset() {
        step = FitStep.CLEAN
        leftSharp = true
        rightSharp = true
        doubles = false
        higherHelps = false
    }
}
