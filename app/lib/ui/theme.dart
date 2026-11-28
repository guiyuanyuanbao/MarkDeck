import 'package:flutter/material.dart';

/// MarkDeck design tokens — a faithful port of web/src/styles.css `:root`
/// variables + the four themes from web/src/theme.ts. Every screen reads
/// these via [MdTheme.of] instead of hard-coding colors, so the app and
/// the web admin stay visually in lockstep.
@immutable
class MdPalette {
  const MdPalette({
    required this.bg,
    required this.surface,
    required this.border,
    required this.text,
    required this.text2,
    required this.text3,
    required this.primary,
    required this.primarySoft,
    required this.danger,
    required this.dangerSoft,
    required this.success,
    required this.warning,
    required this.loginBg1,
    required this.loginBg2,
  });

  final Color bg; // --md-bg (page backdrop)
  final Color surface; // --md-surface (cards)
  final Color border; // --md-border
  final Color text; // --md-text
  final Color text2; // --md-text-2 (secondary)
  final Color text3; // --md-text-3 (meta/hints)
  final Color primary; // --md-primary
  final Color primarySoft; // --md-primary-soft (selection tint)
  final Color danger; // --md-danger
  final Color dangerSoft;
  final Color success; // --md-success
  final Color warning; // --md-warning
  final Color loginBg1; // --md-login-bg1
  final Color loginBg2;

  /// Light-on-primary text (white on all four theme primaries).
  Color get onPrimary => Colors.white;
}

// web/src/theme.ts — indigo 靖紫 / teal 青蓝 / dark 暗夜 / amber 琥珀
const _indigo = MdPalette(
  bg: Color(0xFFF5F6FA),
  surface: Color(0xFFFFFFFF),
  border: Color(0xFFE8EAF1),
  text: Color(0xFF1A1C28),
  text2: Color(0xFF6F7488),
  text3: Color(0xFF9CA1B6),
  primary: Color(0xFF5B67F2),
  primarySoft: Color(0xFFEEF0FE),
  danger: Color(0xFFE5484D),
  dangerSoft: Color(0xFFFDECEC),
  success: Color(0xFF23A877),
  warning: Color(0xFFF5A623),
  loginBg1: Color(0xFFE8EAF6),
  loginBg2: Color(0xFFDDE3FB),
);

const _teal = MdPalette(
  bg: Color(0xFFF2F7F6),
  surface: Color(0xFFFFFFFF),
  border: Color(0xFFDDE9E7),
  text: Color(0xFF14201E),
  text2: Color(0xFF5E7571),
  text3: Color(0xFF93A8A4),
  primary: Color(0xFF0E9488),
  primarySoft: Color(0xFFE2F3F1),
  danger: Color(0xFFE5484D),
  dangerSoft: Color(0xFFFDECEC),
  success: Color(0xFF23A877),
  warning: Color(0xFFF5A623),
  loginBg1: Color(0xFFDFEFEC),
  loginBg2: Color(0xFFCFE9E6),
);

const _dark = MdPalette(
  bg: Color(0xFF12141C),
  surface: Color(0xFF1A1D27),
  border: Color(0xFF2A2E3D),
  text: Color(0xFFE5E7F0),
  text2: Color(0xFF9AA0B5),
  text3: Color(0xFF6B7189),
  primary: Color(0xFF818CF8),
  primarySoft: Color(0xFF262A3E),
  danger: Color(0xFFF25555),
  dangerSoft: Color(0xFF33202A),
  success: Color(0xFF34C48C),
  warning: Color(0xFFF5A623),
  loginBg1: Color(0xFF161826),
  loginBg2: Color(0xFF12141C),
);

const _amber = MdPalette(
  bg: Color(0xFFFAF6F0),
  surface: Color(0xFFFFFFFF),
  border: Color(0xFFF0E7DA),
  text: Color(0xFF241C12),
  text2: Color(0xFF7A6C58),
  text3: Color(0xFFA89A85),
  primary: Color(0xFFD97706),
  primarySoft: Color(0xFFFBEFDF),
  danger: Color(0xFFE5484D),
  dangerSoft: Color(0xFFFDECEC),
  success: Color(0xFF23A877),
  warning: Color(0xFFF5A623),
  loginBg1: Color(0xFFF8EBD7),
  loginBg2: Color(0xFFF3E0C2),
);

class ThemeId {
  static const indigo = 'indigo';
  static const teal = 'teal';
  static const dark = 'dark';
  static const amber = 'amber';
}

const themes = <String, (String, MdPalette)>{
  ThemeId.indigo: ('靖紫', _indigo),
  ThemeId.teal: ('青蓝', _teal),
  ThemeId.dark: ('暗夜', _dark),
  ThemeId.amber: ('琥珀', _amber),
};

/// Inherited palette + badge letter-color gradients (BookmarkAvatar parity).
class MdTheme extends InheritedWidget {
  const MdTheme({super.key, required this.palette, required super.child});

  final MdPalette palette;

  static MdPalette of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<MdTheme>()!.palette;

  @override
  bool updateShouldNotify(MdTheme oldWidget) => oldWidget.palette != palette;

  /// BookmarkAvatar.vue: 6 pastel gradients picked by hash(url|title).
  static const avatarGradients = <List<Color>>[
    [Color(0xFF6B7CF6), Color(0xFF8B5CF6)],
    [Color(0xFF38B2AC), Color(0xFF2B8A84)],
    [Color(0xFFF6AD55), Color(0xFFED8936)],
    [Color(0xFFFC8181), Color(0xFFF56565)],
    [Color(0xFF63B3ED), Color(0xFF4299E1)],
    [Color(0xFFB794F4), Color(0xFF9F7AEA)],
  ];

  static List<Color> avatarColors(String url, String title) {
    var hash = 0;
    final key = url.isNotEmpty ? url : (title.isNotEmpty ? title : 'x');
    for (final c in key.codeUnits) {
      hash = (hash * 31 + c) & 0xFFFFFFFF;
    }
    return avatarGradients[hash % avatarGradients.length];
  }
}

/// Material ThemeData derived from the palette (drift-free glue for
/// standard widgets: sheets, dialogs, switch, chips…).
ThemeData materialTheme(MdPalette p) {
  final scheme = ColorScheme.light(
    primary: p.primary,
    onPrimary: p.onPrimary,
    secondary: p.primary,
    surface: p.surface,
    onSurface: p.text,
    error: p.danger,
    onError: Colors.white,
  );
  return ThemeData(
    colorScheme: scheme,
    useMaterial3: true,
    scaffoldBackgroundColor: p.bg,
    appBarTheme: AppBarTheme(
      backgroundColor: p.surface,
      foregroundColor: p.text,
      elevation: 0,
      scrolledUnderElevation: 0,
      titleTextStyle: TextStyle(
        color: p.text,
        fontSize: 17,
        fontWeight: FontWeight.w700,
      ),
    ),
    cardTheme: CardThemeData(
      color: p.surface,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(color: p.border),
      ),
      margin: EdgeInsets.zero,
    ),
    dividerTheme: DividerThemeData(color: p.border, thickness: 1, space: 1),
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith((states) =>
          states.contains(WidgetState.selected) ? p.primary : p.text3),
      trackColor: WidgetStateProperty.resolveWith((states) =>
          states.contains(WidgetState.selected) ? p.primarySoft : p.border),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: p.primary,
        foregroundColor: p.onPrimary,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: p.text2,
        side: BorderSide(color: p.border),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: p.bg,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide(color: p.border),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide(color: p.border),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide(color: p.primary, width: 1.5),
      ),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: p.surface,
      indicatorColor: p.primarySoft,
      labelTextStyle: WidgetStatePropertyAll(
        TextStyle(fontSize: 11, color: p.text2, fontWeight: FontWeight.w600),
      ),
      iconTheme: WidgetStateProperty.resolveWith((states) => IconThemeData(
            color: states.contains(WidgetState.selected) ? p.primary : p.text3,
          )),
    ),
    checkboxTheme: CheckboxThemeData(
      fillColor: WidgetStateProperty.resolveWith((states) =>
          states.contains(WidgetState.selected) ? p.primary : Colors.transparent),
      side: BorderSide(color: p.text3, width: 1.5),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(4)),
    ),
    listTileTheme: ListTileThemeData(
      iconColor: p.text2,
      titleTextStyle: TextStyle(
          color: p.text, fontSize: 14, fontWeight: FontWeight.w500),
      subtitleTextStyle: TextStyle(color: p.text3, fontSize: 12),
    ),
    popupMenuTheme: PopupMenuThemeData(
      color: p.surface,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: p.border),
      ),
      textStyle: TextStyle(color: p.text, fontSize: 13.5),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: p.surface,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: p.border),
      ),
      titleTextStyle: TextStyle(
          color: p.text, fontSize: 16, fontWeight: FontWeight.w700),
    ),
    bottomSheetTheme: const BottomSheetThemeData(
      clipBehavior: Clip.antiAlias,
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: p.text,
      contentTextStyle: const TextStyle(color: Colors.white, fontSize: 13),
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
    ),
  );
}
