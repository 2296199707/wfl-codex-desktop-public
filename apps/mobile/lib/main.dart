import 'package:flutter/material.dart';

import 'credentials/credential_store.dart';
import 'storage/app_database.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final database = await createAppDatabase();
  runApp(WflMobileApp(database: database, credentials: createCredentialStore()));
}

class WflMobileApp extends StatelessWidget {
  const WflMobileApp({super.key, required this.database, required this.credentials});

  final AppDatabase database;
  final CredentialStore credentials;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'WFL Codex Mobile',
      theme: ThemeData(
        colorSchemeSeed: Colors.indigo,
        fontFamily: 'NotoSansSC',
        useMaterial3: true,
      ),
      home: MobileHomePage(database: database, credentials: credentials),
    );
  }
}

class MobileHomePage extends StatefulWidget {
  const MobileHomePage({super.key, required this.database, required this.credentials});

  final AppDatabase database;
  final CredentialStore credentials;

  @override
  State<MobileHomePage> createState() => _MobileHomePageState();
}

class _MobileHomePageState extends State<MobileHomePage> {
  int _index = 0;
  List<AppServer> _servers = [];

  @override
  void initState() {
    super.initState();
    _loadServers();
  }

  Future<void> _loadServers() async {
    final servers = await widget.database.listServers();
    if (mounted) setState(() => _servers = servers);
  }

  Future<void> _editServer([AppServer? existing]) async {
    final name = TextEditingController(text: existing?.name ?? '');
    final host = TextEditingController(text: existing?.host ?? '');
    final formKey = GlobalKey<FormState>();
    final result = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (context) => Padding(
        padding: EdgeInsets.fromLTRB(20, 20, 20, MediaQuery.viewInsetsOf(context).bottom + 20),
        child: Form(
          key: formKey,
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Text(existing == null ? '新增服务器' : '编辑服务器', style: Theme.of(context).textTheme.titleLarge),
            TextFormField(controller: name, decoration: const InputDecoration(labelText: '名称'), validator: _required),
            TextFormField(controller: host, decoration: const InputDecoration(labelText: '地址'), validator: _required),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: () async {
                if (!formKey.currentState!.validate()) return;
                await widget.database.saveServer(AppServer(
                  id: existing?.id ?? DateTime.now().microsecondsSinceEpoch.toString(),
                  name: name.text.trim(),
                  host: host.text.trim(),
                ));
                if (context.mounted) Navigator.pop(context, true);
              },
              child: const Text('保存'),
            ),
          ]),
        ),
      ),
    );
    name.dispose();
    host.dispose();
    if (result == true) _loadServers();
  }

  Future<void> _deleteServer(AppServer server) async {
    final confirmed = await showDialog<bool>(
          context: context,
          builder: (context) => AlertDialog(
            title: const Text('删除服务器？'),
            content: Text(server.name),
            actions: [
              TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
              FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('删除')),
            ],
          ),
        ) ??
        false;
    if (!confirmed) return;
    await widget.database.deleteServer(server.id);
    _loadServers();
  }

  String? _required(String? value) => value == null || value.trim().isEmpty ? '请填写此项' : null;

  @override
  Widget build(BuildContext context) {
    final pages = [
      _TasksPage(servers: _servers),
      _ServersPage(servers: _servers, onAdd: _editServer, onEdit: _editServer, onDelete: _deleteServer),
      const _SettingsPage(),
    ];
    return Scaffold(
      appBar: AppBar(title: const Text('WFL Codex Mobile'), actions: [
        const Padding(padding: EdgeInsets.only(right: 12), child: Chip(label: Text('预览模式'))),
      ]),
      body: pages[_index],
      bottomNavigationBar: NavigationBar(selectedIndex: _index, onDestinationSelected: (value) => setState(() => _index = value), destinations: const [
        NavigationDestination(icon: Icon(Icons.task_alt), label: '任务'),
        NavigationDestination(icon: Icon(Icons.dns), label: '服务器'),
        NavigationDestination(icon: Icon(Icons.settings), label: '设置'),
      ]),
    );
  }
}

class _TasksPage extends StatelessWidget {
  const _TasksPage({required this.servers});
  final List<AppServer> servers;
  @override
  Widget build(BuildContext context) => ListView(padding: const EdgeInsets.all(20), children: [
        Text('任务', style: Theme.of(context).textTheme.headlineMedium),
        const SizedBox(height: 8),
        const Card(child: ListTile(leading: Icon(Icons.pause_circle_outline), title: Text('暂无任务'), subtitle: Text('新增服务器后可以在这里查看同步状态。'))),
        Card(child: ListTile(leading: const Icon(Icons.dns), title: Text('${servers.length} 个演示服务器'), subtitle: const Text('数据只保存在当前预览页面内。'))),
      ]);
}

class _ServersPage extends StatelessWidget {
  const _ServersPage({required this.servers, required this.onAdd, required this.onEdit, required this.onDelete});
  final List<AppServer> servers;
  final Future<void> Function([AppServer?]) onAdd;
  final Future<void> Function(AppServer) onEdit;
  final Future<void> Function(AppServer) onDelete;
  @override
  Widget build(BuildContext context) => ListView(padding: const EdgeInsets.all(20), children: [
        Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [Text('服务器', style: Theme.of(context).textTheme.headlineMedium), IconButton(onPressed: () => onAdd(), icon: const Icon(Icons.add))]),
        ...servers.map((server) => Card(child: ListTile(leading: const Icon(Icons.dns), title: Text(server.name), subtitle: Text(server.host), trailing: PopupMenuButton<String>(onSelected: (value) => value == 'edit' ? onEdit(server) : onDelete(server), itemBuilder: (context) => const [PopupMenuItem(value: 'edit', child: Text('编辑')), PopupMenuItem(value: 'delete', child: Text('删除'))])))),
      ]);
}

class _SettingsPage extends StatelessWidget {
  const _SettingsPage();
  @override
  Widget build(BuildContext context) => ListView(padding: const EdgeInsets.all(20), children: [
        Text('设置', style: Theme.of(context).textTheme.headlineMedium),
        const SizedBox(height: 8),
        const Card(child: ListTile(leading: Icon(Icons.visibility), title: Text('预览模式'), subtitle: Text('数据、凭据和供应商请求不会保存或发送到真实服务。'))),
        const Card(child: ListTile(leading: Icon(Icons.palette_outlined), title: Text('界面设置'), subtitle: Text('这里用于演示设置页面和底部导航。'))),
      ]);
}
