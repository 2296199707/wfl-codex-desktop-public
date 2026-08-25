class AppServer {
  AppServer({required this.id, required this.name, required this.host});

  final String id;
  String name;
  String host;
}

abstract class AppDatabase {
  Future<List<AppServer>> listServers();
  Future<void> saveServer(AppServer server);
  Future<void> deleteServer(String id);
  Future<void> close();
}

class MemoryAppDatabase implements AppDatabase {
  final List<AppServer> _servers = [
    AppServer(id: 'demo-server', name: '演示服务器', host: 'demo.example.test'),
  ];

  @override
  Future<List<AppServer>> listServers() async => List<AppServer>.of(_servers);

  @override
  Future<void> saveServer(AppServer server) async {
    final index = _servers.indexWhere((item) => item.id == server.id);
    if (index == -1) {
      _servers.add(server);
    } else {
      _servers[index] = server;
    }
  }

  @override
  Future<void> deleteServer(String id) async {
    _servers.removeWhere((server) => server.id == id);
  }

  @override
  Future<void> close() async {}
}

AppDatabase createAppDatabase() => MemoryAppDatabase();
