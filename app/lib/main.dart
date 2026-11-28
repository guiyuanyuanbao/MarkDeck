import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import 'state/app_controller.dart';
import 'ui/browse_screen.dart';
import 'ui/devices_screen.dart';
import 'ui/import_screen.dart';
import 'ui/pair_screen.dart';
import 'ui/settings_screen.dart';
import 'ui/tags_screen.dart';
import 'ui/theme.dart';
import 'ui/tools_screen.dart';
import 'ui/trash_screen.dart';
import 'ui/edit_sheet.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(SystemUiOverlayStyle.dark);
  runApp(const MarkDeckApp());
}

class MarkDeckApp extends StatelessWidget {
  const MarkDeckApp({super.key});

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider(
      create: (_) => AppController()..boot(),
      child: Consumer<AppController>(
        builder: (context, app, _) {
          final palette = themes[app.themeId]!.$2;
          return MdTheme(
            palette: palette,
            child: MaterialApp(
              title: 'MarkDeck',
              theme: materialTheme(palette),
              home: app.booted
                  ? (app.paired ? const HomeShell() : const PairScreen())
                  : const BootingScreen(),
            ),
          );
        },
      ),
    );
  }
}

class BootingScreen extends StatelessWidget {
  const BootingScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final p = MdTheme.of(context);
    return Scaffold(
      backgroundColor: p.bg,
      body: Center(child: CircularProgressIndicator(color: p.primary)),
    );
  }
}

/// Top-bar IA mirroring the web admin (App.vue): logo + 5 primary nav items
/// + utility cluster. On a phone the nav collapses into a scrollable pill
/// row under the brand bar; utilities (设备/设置/主题/退出) live in an
/// overflow sheet. Content = file-manager body.
class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> with WidgetsBindingObserver {
  int _tab = 0;
  StreamSubscription<String>? _shareSub;

  static const _method = MethodChannel('markdeck/share');

  // App.vue nav: 书签 · 回收站 · 标签 · 工具 · 导入导出
  static const _tabs = [
    (Icons.bookmark_border, Icons.bookmark, '书签'),
    (Icons.delete_outline, Icons.delete_outline, '回收站'),
    (Icons.label_outline, Icons.label_outline, '标签'),
    (Icons.build_outlined, Icons.build_outlined, '工具'),
    (Icons.inventory_2_outlined, Icons.inventory_2, '导入导出'),
  ];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _listenShares();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _shareSub?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final app = context.read<AppController>();
    switch (state) {
      case AppLifecycleState.resumed:
        app.onAppResume();
      case AppLifecycleState.paused:
      case AppLifecycleState.hidden:
        app.onAppPause();
      default:
        break;
    }
  }

  void _listenShares() {
    _method.setMethodCallHandler((call) async {
      if (call.method == 'onShare' && call.arguments is String) {
        _openQuickSave(call.arguments as String);
      }
      return null;
    });
    _method.invokeMethod<String>('takePendingShare').then((pending) {
      if (pending != null && pending.isNotEmpty) _openQuickSave(pending);
    }).catchError((_) {});
  }

  void _openQuickSave(String payload) {
    if (!mounted) return;
    final app = context.read<AppController>();
    if (!app.paired) return;
    final lines = payload.trim().split('\n');
    var url = '';
    var title = '';
    for (final line in lines) {
      final t = line.trim();
      if (t.isEmpty) continue;
      if (url.isEmpty && (t.startsWith('http://') || t.startsWith('https://'))) {
        url = t;
      } else if (title.isEmpty) {
        title = t;
      }
    }
    if (url.isEmpty) return;
    if (title.isEmpty) {
      try {
        title = Uri.parse(url).host;
      } on FormatException {
        title = url;
      }
    }
    showEditSheet(context, app.db, presetTitle: title, presetUrl: url);
  }

  // ---- utility sheet: 设备 · 设置 · 主题 · 退出 (web header right cluster) ----

  void _openUtilities() {
    final app = context.read<AppController>();
    showModalBottomSheet<void>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(height: 8),
            ListTile(
              leading: const Icon(Icons.devices),
              title: const Text('配对设备'),
              onTap: () {
                Navigator.pop(ctx);
                Navigator.push(ctx, MaterialPageRoute(builder: (_) => const DevicesScreen()));
              },
            ),
            ListTile(
              leading: const Icon(Icons.settings_outlined),
              title: const Text('设置'),
              onTap: () {
                Navigator.pop(ctx);
                Navigator.push(ctx, MaterialPageRoute(builder: (_) => const SettingsScreen()));
              },
            ),
            const Divider(height: 1),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text('配色主题', style: TextStyle(fontSize: 12, color: MdTheme.of(ctx).text3)),
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Row(
                children: [
                  for (final entry in themes.entries)
                    Expanded(
                      child: _ThemeDot(
                        id: entry.key,
                        label: entry.value.$1,
                        palette: entry.value.$2,
                        selected: app.themeId == entry.key,
                      ),
                    ),
                ],
              ),
            ),
            const Divider(height: 24),
            ListTile(
              leading: Icon(Icons.logout, color: MdTheme.of(ctx).danger),
              title: Text('退出登录', style: TextStyle(color: MdTheme.of(ctx).danger)),
              onTap: () async {
                Navigator.pop(ctx);
                await app.unpair();
                if (ctx.mounted) {
                  Navigator.of(ctx, rootNavigator: true).popUntil((r) => r.isFirst);
                }
              },
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = MdTheme.of(context);
    const screens = [
      BrowseScreen(),
      TrashScreen(),
      TagsScreen(),
      ToolsScreen(),
      ImportScreen(),
    ];
    return Scaffold(
      backgroundColor: p.bg,
      appBar: _header(p),
      body: IndexedStack(index: _tab, children: screens),
    );
  }

  /// Sticky brand bar + pill nav (web .md-header, phone-adapted).
  PreferredSizeWidget _header(MdPalette p) {
    return AppBar(
      backgroundColor: p.surface,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      toolbarHeight: 96,
      titleSpacing: 0,
      flexibleSpace: SafeArea(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // row 1: logo + MarkDeck + utilities button
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 8, 0),
              child: Row(
                children: [
                  Container(
                    width: 28,
                    height: 28,
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(8),
                      boxShadow: [
                        BoxShadow(
                          color: p.primary.withValues(alpha: 0.25),
                          blurRadius: 6,
                        ),
                      ],
                    ),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(8),
                      child: Image.asset('assets/logo.png', fit: BoxFit.cover),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text('MarkDeck',
                      style: TextStyle(
                          fontSize: 16, fontWeight: FontWeight.w800, color: p.text)),
                  const Spacer(),
                  IconButton(
                    icon: Stack(
                      children: [
                        const Icon(Icons.apps),
                        Positioned(
                          right: 0,
                          bottom: 0,
                          child: Container(
                            width: 8,
                            height: 8,
                            decoration:
                                BoxDecoration(color: p.primary, shape: BoxShape.circle),
                          ),
                        ),
                      ],
                    ),
                    tooltip: '设备 / 设置 / 主题',
                    onPressed: _openUtilities,
                  ),
                ],
              ),
            ),
            // row 2: primary nav pills (书签/回收站/标签/工具/导入导出)
            SizedBox(
              height: 40,
              child: ListView(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                children: [
                  for (var i = 0; i < _tabs.length; i++)
                    _NavPill(
                      icon: _tab == i ? _tabs[i].$2 : _tabs[i].$1,
                      label: _tabs[i].$3,
                      active: _tab == i,
                      onTap: () => setState(() => _tab = i),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _NavPill extends StatelessWidget {
  const _NavPill({required this.icon, required this.label, required this.active, required this.onTap});

  final IconData icon;
  final String label;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = MdTheme.of(context);
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: Material(
        color: active ? p.primarySoft : Colors.transparent,
        borderRadius: BorderRadius.circular(999),
        child: InkWell(
          borderRadius: BorderRadius.circular(999),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(icon, size: 15, color: active ? p.primary : p.text2),
                const SizedBox(width: 6),
                Text(
                  label,
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: active ? FontWeight.w700 : FontWeight.w500,
                    color: active ? p.primary : p.text2,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ThemeDot extends StatelessWidget {
  const _ThemeDot({
    required this.id,
    required this.label,
    required this.palette,
    required this.selected,
  });

  final String id;
  final String label;
  final MdPalette palette;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final app = context.read<AppController>();
    return InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: () {
        app.setTheme(id);
        Navigator.pop(context);
      },
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Column(
          children: [
            Container(
              width: 36,
              height: 36,
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [palette.primary, palette.loginBg1],
                ),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(
                  color: selected ? palette.primary : palette.border,
                  width: selected ? 2 : 1,
                ),
              ),
            ),
            const SizedBox(height: 4),
            Text(label,
                style: TextStyle(
                    fontSize: 11,
                    color: selected ? palette.primary : palette.text2,
                    fontWeight: selected ? FontWeight.w700 : FontWeight.w500)),
          ],
        ),
      ),
    );
  }
}
