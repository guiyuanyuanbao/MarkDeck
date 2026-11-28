import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../state/app_controller.dart';
import '../store/database.dart';
import 'widgets.dart';
import 'edit_sheet.dart' show tagsFromJson;

/// Offline-capable full-text search over the local mirror (LIKE substring —
/// thousands of rows scan in milliseconds; trigram upgrade later) + tag
/// filter chips with counts.
class SearchScreen extends StatefulWidget {
  const SearchScreen({super.key});

  @override
  State<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends State<SearchScreen> {
  final _query = TextEditingController();
  String _tagFilter = '';

  AppDatabase get _db => context.read<AppController>().db;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('搜索')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
            child: TextField(
              controller: _query,
              onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(
                prefixIcon: Icon(Icons.search),
                hintText: '搜索标题 / URL / 备注',
                border: OutlineInputBorder(),
              ),
            ),
          ),
          SizedBox(
            height: 48,
            child: StreamBuilder<List<Node>>(
              stream: _db.watchAllLive(),
              builder: (context, snap) {
                final counts = <String, int>{};
                for (final r in snap.data ?? const <Node>[]) {
                  for (final t in tagsFromJson(r.tags)) {
                    counts[t] = (counts[t] ?? 0) + 1;
                  }
                }
                final tags = counts.keys.toList()..sort();
                return ListView(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  children: [
                    Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: FilterChip(
                        label: const Text('全部'),
                        selected: _tagFilter.isEmpty,
                        onSelected: (_) => setState(() => _tagFilter = ''),
                      ),
                    ),
                    for (final t in tags)
                      Padding(
                        padding: const EdgeInsets.only(right: 8),
                        child: FilterChip(
                          label: Text('$t (${counts[t]})'),
                          selected: _tagFilter == t,
                          onSelected: (_) => setState(() => _tagFilter = _tagFilter == t ? '' : t),
                        ),
                      ),
                  ],
                );
              },
            ),
          ),
          const Divider(height: 1),
          Expanded(child: _results()),
        ],
      ),
    );
  }

  Widget _results() {
    final q = _query.text.trim().toLowerCase();
    return StreamBuilder<List<Node>>(
      stream: _db.watchAllLive(),
      builder: (context, snap) {
        var rows = (snap.data ?? const <Node>[]).where((r) => r.type == 'url').toList();
        if (q.isNotEmpty) {
          bool matches(Node r) =>
              r.title.toLowerCase().contains(q) ||
              (r.url ?? '').toLowerCase().contains(q) ||
              r.note.toLowerCase().contains(q);
          rows = rows.where(matches).toList();
        }
        if (_tagFilter.isNotEmpty) {
          rows = rows.where((r) => tagsFromJson(r.tags).contains(_tagFilter)).toList();
        }
        if (rows.isEmpty) {
          return Center(
            child: Text(
              q.isEmpty ? '输入关键词开始搜索' : '没有匹配结果',
              style: TextStyle(color: Theme.of(context).colorScheme.outline),
            ),
          );
        }
        return ListView.builder(
          itemCount: rows.length,
          itemBuilder: (context, i) {
            final r = rows[i];
            return ListTile(
              leading: BookmarkAvatar(url: r.url ?? '', title: r.title, size: 32),
              title: Text(r.title, maxLines: 1, overflow: TextOverflow.ellipsis),
              subtitle: Text(r.url ?? '', maxLines: 1, overflow: TextOverflow.ellipsis),
              trailing: r.favorite
                  ? Icon(Icons.star, color: Theme.of(context).colorScheme.primary, size: 18)
                  : null,
              onTap: () => _open(r.url),
            );
          },
        );
      },
    );
  }

  Future<void> _open(String? url) async {
    if (url == null || url.isEmpty) return;
    final uri = Uri.tryParse(url);
    if (uri == null) return;
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }
}
