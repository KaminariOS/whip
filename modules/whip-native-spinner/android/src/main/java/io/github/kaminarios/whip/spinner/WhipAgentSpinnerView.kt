package io.github.kaminarios.whip.spinner

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.view.animation.LinearInterpolator
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

class WhipAgentSpinnerView(
  context: Context,
  appContext: AppContext,
) : ExpoView(context, appContext) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private var animationEnabled = true
  private var rotationDegrees = 0f
  private var rotationDurationMs = DEFAULT_ROTATION_DURATION_MS

  private val animator = ValueAnimator.ofFloat(0f, 360f).apply {
    duration = rotationDurationMs
    interpolator = LinearInterpolator()
    repeatCount = ValueAnimator.INFINITE
    addUpdateListener {
      rotationDegrees = it.animatedValue as Float
      invalidate()
    }
  }

  init {
    paint.color = Color.WHITE
    setWillNotDraw(false)
  }

  fun setSpinnerColor(color: Int) {
    paint.color = color
    invalidate()
  }

  fun setRotationDuration(durationMs: Long) {
    val nextDuration = durationMs.coerceAtLeast(MIN_ROTATION_DURATION_MS)
    if (rotationDurationMs == nextDuration) return
    rotationDurationMs = nextDuration
    animator.duration = nextDuration
    restartAnimationIfNeeded()
  }

  fun setAnimationEnabled(enabled: Boolean) {
    if (animationEnabled == enabled) return
    animationEnabled = enabled
    updateAnimationState()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    updateAnimationState()
  }

  override fun onDetachedFromWindow() {
    animator.cancel()
    super.onDetachedFromWindow()
  }

  override fun onVisibilityAggregated(isVisible: Boolean) {
    super.onVisibilityAggregated(isVisible)
    updateAnimationState()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val extent = min(width, height).toFloat()
    if (extent <= 0f) return

    val centerX = width / 2f
    val centerY = height / 2f
    val orbitRadius = extent * ORBIT_RADIUS_RATIO
    val dotRadius = extent * DOT_RADIUS_RATIO
    val baseAlpha = Color.alpha(paint.color)

    canvas.save()
    canvas.rotate(rotationDegrees, centerX, centerY)
    TRAIL_OPACITIES.forEachIndexed { trailIndex, opacity ->
      val angle = -PI / 2.0 - trailIndex * POSITION_ANGLE_RADIANS
      paint.alpha = (baseAlpha * opacity).toInt().coerceIn(0, 255)
      canvas.drawCircle(
        centerX + cos(angle).toFloat() * orbitRadius,
        centerY + sin(angle).toFloat() * orbitRadius,
        dotRadius,
        paint,
      )
    }
    paint.alpha = baseAlpha
    canvas.restore()
  }

  private fun restartAnimationIfNeeded() {
    if (!animator.isStarted) return
    animator.cancel()
    animator.start()
  }

  private fun updateAnimationState() {
    if (animationEnabled && isAttachedToWindow && isShown) {
      if (!animator.isStarted) animator.start()
      return
    }

    animator.cancel()
    rotationDegrees = 0f
    invalidate()
  }

  private companion object {
    const val DEFAULT_ROTATION_DURATION_MS = 700L
    const val MIN_ROTATION_DURATION_MS = 100L
    const val ORBIT_RADIUS_RATIO = 9.5f / 24f
    const val DOT_RADIUS_RATIO = 2f / 24f
    const val POSITION_ANGLE_RADIANS = 2.0 * PI / 10.0
    val TRAIL_OPACITIES = floatArrayOf(1f, 0.72f, 0.5f, 0.32f, 0.16f)
  }
}
