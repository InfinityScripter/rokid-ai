package com.rokidai.vision

// Что делать с двоением. Разбор идёт по одному признаку: пропадает ли двоение,
// когда закрыт один глаз. Пропадает — картинки очков не сходятся, это лечится
// посадкой. Не пропадает — дело в самом глазу, и посадкой тут не помочь.
enum class FitAdvice(val title: String, val text: String) {
    OK(
        "ВСЁ РОВНО",
        "Картинка сходится.\nВернётся двоение — пройди снова.",
    ),
    FOCUS(
        "ДЕЛО НЕ В ОЧКАХ",
        "Одним глазом тоже нечётко.\nПохоже на астигматизм.\nНужны линзы-вставки и окулист.",
    ),
    SEATING(
        "ПОСАДКА",
        "Подъём помог.\nСведи носоупоры внутрь,\nчтобы очки так и сидели.",
    ),
    ALIGNMENT(
        "НУЖНА ПРОВЕРКА",
        "Дай надеть другому.\nДвоит и у него — пиши в Rokid.\nТолько у тебя — к окулисту.",
    ),
}

fun adviceFor(leftSharp: Boolean, rightSharp: Boolean, doubles: Boolean, higherHelps: Boolean): FitAdvice = when {
    // Нечёткость одним глазом двоения не объясняет: она остаётся, даже когда
    // второй глаз закрыт, — значит сведение картинок ни при чём.
    !leftSharp || !rightSharp -> FitAdvice.FOCUS
    !doubles -> FitAdvice.OK
    higherHelps -> FitAdvice.SEATING
    else -> FitAdvice.ALIGNMENT
}
