package com.rokidai.vision

// Карточка пробы: одно слово, показанное определённым размером, толщиной
// и в определённом месте экрана. Полный перебор трёх осей даёт ровно 40
// карточек — примерно четыре-пять минут с непривычки.
data class Card(val word: String, val size: Int, val bold: Boolean, val zone: String)

data class Answer(val size: Int, val bold: Boolean, val zone: String, val read: Boolean)

val SIZES = listOf(14, 20, 28, 36)
val ZONES = listOf("center", "top", "bottom", "left", "right")

// Слова короткие и обиходные, все разные: повтор слова научил бы узнавать
// его по общему очертанию, и проба мерила бы память, а не читаемость.
private val WORDS = listOf(
    "вода", "книга", "стол", "окно", "город", "поезд", "ветер", "дождь",
    "рука", "голос", "время", "дверь", "песок", "ключ", "мысль", "врач",
    "парк", "снег", "море", "лампа", "хлеб", "кот", "дорога", "мост",
    "сон", "звук", "лес", "друг", "шаг", "зима", "круг", "лист",
    "ночь", "огонь", "палец", "речь", "сад", "тень", "утро", "чай",
)

// Порядок карточек перемешан: иначе усталость глаз легла бы целиком на
// последнюю ось перебора и испортила именно её данные.
fun buildPlan(): List<Card> {
    val combos = SIZES.flatMap { size ->
        listOf(false, true).flatMap { bold ->
            ZONES.map { zone -> Triple(size, bold, zone) }
        }
    }.shuffled()
    val words = WORDS.shuffled()
    return combos.mapIndexed { i, (size, bold, zone) ->
        Card(words[i % words.size], size, bold, zone)
    }
}
