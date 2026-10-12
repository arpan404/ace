package dev.ace.nativeui

import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import expo.modules.kotlin.views.ComposeProps
import expo.modules.kotlin.views.FunctionalComposableScope
import expo.modules.kotlin.views.OptimizedComposeProps
import expo.modules.ui.UIComposableScope
import org.json.JSONObject

@OptimizedComposeProps
data class AceThemeProps(val tokens: String = "", val dark: Boolean = false) : ComposeProps

// Both the React Native styles and this Compose subtree consume the same validated JSON.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FunctionalComposableScope.AceThemeContent(props: AceThemeProps) {
  val data = remember(props.tokens) { JSONObject(props.tokens) }
  val scheme = data.getJSONObject("schemes").getJSONObject(if (props.dark) "dark" else "light")
  val colours = scheme.getJSONObject("colours")
  fun colour(name: String) = Color(android.graphics.Color.parseColor(colours.getString(name)))
  val palette = if (props.dark) darkColorScheme() else lightColorScheme()
  val fixed = palette.copy(
    primary = colour("accent"), onPrimary = colour("onAccent"),
    primaryContainer = colour("fill"), onPrimaryContainer = colour("foreground"),
    secondary = colour("mutedForeground"), onSecondary = colour("background"),
    secondaryContainer = colour("fill"), onSecondaryContainer = colour("foreground"),
    tertiary = colour("accent"), onTertiary = colour("onAccent"),
    tertiaryContainer = colour("fill"), onTertiaryContainer = colour("foreground"),
    background = colour("background"), onBackground = colour("foreground"),
    surface = colour("card"), onSurface = colour("foreground"),
    surfaceVariant = colour("secondaryBackground"), onSurfaceVariant = colour("mutedForeground"),
    surfaceTint = Color.Transparent, inverseSurface = colour("foreground"),
    inverseOnSurface = colour("background"), inversePrimary = colour("accent"),
    outline = colour("separator"), outlineVariant = colour("separator"), scrim = colour("scrim"),
    error = Color(android.graphics.Color.parseColor(scheme.getJSONObject("status").getString("failed"))),
    onError = colour("background"), errorContainer = colour("diffDelete"), onErrorContainer = colour("foreground"),
    surfaceDim = colour("secondaryBackground"), surfaceBright = colour("card"),
    surfaceContainerLowest = colour("background"), surfaceContainerLow = colour("secondaryBackground"),
    surfaceContainer = colour("card"), surfaceContainerHigh = colour("fill"), surfaceContainerHighest = colour("fill")
  )
  val context = LocalContext.current
  val inter = remember { FontFamily(android.graphics.Typeface.createFromAsset(context.assets, "fonts/Inter.ttf")) }
  val scale = data.getJSONObject("typography").getJSONObject("typeScale")
  fun style(name: String): TextStyle {
    val token = scale.getJSONObject(name)
    return TextStyle(fontFamily = inter, fontSize = token.getDouble("size").toFloat().sp,
      lineHeight = token.getDouble("lineHeight").toFloat().sp,
      fontWeight = FontWeight(token.getInt("weight")),
      letterSpacing = token.getDouble("letterSpacing").toFloat().sp)
  }
  val typography = Typography(
    displayLarge = style("wordmark"), displayMedium = style("wordmark"), displaySmall = style("wordmark"),
    headlineLarge = style("title"), headlineMedium = style("title"), headlineSmall = style("title"),
    titleLarge = style("title"), titleMedium = style("rowTitle"), titleSmall = style("label"),
    bodyLarge = style("body"), bodyMedium = style("body"), bodySmall = style("caption"),
    labelLarge = style("body"), labelMedium = style("label"), labelSmall = style("caption")
  )
  val radii = data.getJSONObject("radii")
  fun shape(name: String) = RoundedCornerShape(radii.getDouble(name).toFloat().dp)
  MaterialTheme(colorScheme = fixed, typography = typography,
    shapes = Shapes(shape("badge"), shape("small"), shape("button"), shape("card"), shape("sheet"))) {
    val opacity = scheme.getJSONObject("opacity").getDouble("ripple").toFloat()
    CompositionLocalProvider(
      LocalRippleConfiguration provides RippleConfiguration(color = colour("foreground"),
        rippleAlpha = androidx.compose.material.ripple.RippleAlpha(opacity, opacity, opacity, opacity)),
      LocalIndication provides ripple(color = colour("foreground")),
      LocalTextStyle provides style("body")
    ) { Children(UIComposableScope()) }
  }
}
