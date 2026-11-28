import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import 'state/app_controller.dart';
import 'ui/browse_screen.dart';
import 'ui/edit_sheet.dart';
import 'ui/mine_screen.dart';
import 'ui/pair_screen.dart';
import 'ui/tags_screen.dart';
import 'ui/theme.dart';
import 'ui/trash_screen.dart';

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

/// Bottom-tab IA (phone convention): 书签 · 回收站 · 标签 · 我的。
/// Low-frequency/admin surfaces (工具/导入导出/设备/设置) live inside 我的
/// behind admin gating. Content tabs are independent Scaffolds in an
/// IndexedStack, so tab state survives switches.
class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> with WidgetsBindingObserver {
  int _tab = 0;
  StreamSubscription<String>? _shareSub;

  static const _method = MethodChannel('markdeck/share');

  // 书签 · 回收站 · 标签 · 我的
  static const _tabs = [
    (Icons.bookmark_outline, Icons.bookmark, '书签'),
    (Icons.delete_outline, Icons.delete, '回收站'),
    (Icons.label_outline, Icons.label, '标签'),
    (Icons.person_outline, Icons.person, '我的'),
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

  @override
  Widget build(BuildContext context) {
    final p = MdTheme.of(context);
    return Scaffold(
      backgroundColor: p.bg,
      body: IndexedStack(
        index: _tab,
        children: [
          const BrowseScreen(),
          TrashScreen(active: _tab == 1),
          const TagsScreen(),
          const MineScreen(),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: [
          for (final t in _tabs)
            NavigationDestination(
              icon: Icon(t.$1),
              selectedIcon: Icon(t.$2),
              label: t.$3,
            ),
        ],
      ),
    );
  }
}
