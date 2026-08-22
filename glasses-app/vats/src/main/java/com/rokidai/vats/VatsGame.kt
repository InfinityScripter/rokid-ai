package com.rokidai.vats

// Игровое состояние VATS: очки действия, шкала крита, вердикт выстрела.
// Чистая логика без Android — покрыта юнит-тестами.
class VatsGame(private val rng: () -> Float = { kotlin.random.Random.nextFloat() }) {

    companion object {
        const val AP_MAX = 9
        const val AP_SHOT_COST = 3
        const val AP_REGEN_MS = 1600L
        const val VERDICT_MS = 900L
        const val CRIT_ON_HIT = 0.18f
        const val CRIT_ON_MISS = 0.06f
    }

    var ap = AP_MAX
        private set
    var crit = 0.35f
        private set
    private var verdictText: String? = null
    private var verdictOk = false
    private var verdictUntil = 0L
    private var lastRegenAt = Long.MIN_VALUE

    // null — стрелять нечем (не хватает ОД); иначе попал/промазал.
    fun shoot(now: Long, chancePct: Int): Boolean? {
        if (ap < AP_SHOT_COST) return null
        ap -= AP_SHOT_COST
        lastRegenAt = now
        val hit = rng() * 100 < chancePct
        crit = (crit + if (hit) CRIT_ON_HIT else CRIT_ON_MISS).coerceAtMost(1f)
        verdictText = if (hit) "ПОПАЛ" else "ПРОМАХ"
        verdictOk = hit
        verdictUntil = now + VERDICT_MS
        return hit
    }

    // Восстановление ОД: по одному за каждые AP_REGEN_MS.
    fun tick(now: Long) {
        if (lastRegenAt == Long.MIN_VALUE) lastRegenAt = now
        while (ap < AP_MAX && now - lastRegenAt >= AP_REGEN_MS) {
            ap++
            lastRegenAt += AP_REGEN_MS
        }
        if (ap == AP_MAX) lastRegenAt = now
    }

    // Текущий штамп ПОПАЛ/ПРОМАХ или null, если время вышло.
    fun verdict(now: Long): Pair<String, Boolean>? {
        val t = verdictText ?: return null
        if (now >= verdictUntil) return null
        return t to verdictOk
    }
}
