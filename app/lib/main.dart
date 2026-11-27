import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'state/app_controller.dart';
import 'ui/browse_screen.dart';
import 'ui/pair_screen.dart';
import 'ui/search_screen.dart';
import 'ui/settings_screen.dart';
import 'ui/tags_screen.dart';
import 'ui/tools_screen.dart';
import 'ui/trash_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
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
          final dark = MediaQuery.platformBrightnessOf(context) == Brightness.dark;
          final scheme = ColorScheme.fromSeed(
            seedColor: const Color(0xFF3D6FE0),
            brightness: dark ? Brightness.dark : Brightness.light,
          );
          return MaterialApp(
            title: 'MarkDeck',
            theme: ThemeData(colorScheme: scheme, useMaterial3: true),
            home: app.booted
                ? (app.paired ? const HomeShell() : const PairScreen())
                : const BootingScreen(),
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
    return const Scaffold(
      body: Center(child: CircularProgressIndicator()),
    );
  }
}

/// Bottom-nav shell: browse / search / tags / trash / tools / settings.
class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _tab = 0;

  static const _tabs = [
    (Icons.folder_outlined, Icons.folder, '书签'),
    (Icons.search_outlined, Icons.search, '搜索'),
    (Icons.label_outline, Icons.label, '标签'),
    (Icons.delete_outline, Icons.delete, '回收站'),
    (Icons.build_outlined, Icons.build, '工具'),
    (Icons.settings_outlined, Icons.settings, '设置'),
  ];

  @override
  Widget build(BuildContext context) {
    const screens = [
      BrowseScreen(),
      SearchScreen(),
      TagsScreen(),
      TrashScreen(),
      ToolsScreen(),
      SettingsScreen(),
    ];
    return Scaffold(
      body: IndexedStack(index: _tab, children: screens),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: [
          for (final (outlined, filled, label) in _tabs)
            NavigationDestination(
              icon: Icon(outlined),
              selectedIcon: Icon(filled),
              label: label,
            ),
        ],
      ),
    );
  }
}
