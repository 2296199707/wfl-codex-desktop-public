import 'package:flutter_test/flutter_test.dart';
import 'package:wfl_mobile_app/credentials/memory_credential_store.dart';
import 'package:wfl_mobile_app/storage/memory_app_database.dart';

void main() {
  test('memory preview data resets to the demo server', () async {
    final database = MemoryAppDatabase();
    expect((await database.listServers()).single.name, '演示服务器');
    await database.saveServer(AppServer(id: 'new', name: '新服务器', host: 'new.test'));
    expect((await database.listServers()).length, 2);
  });

  test('preview credentials stay in memory', () async {
    final credentials = MemoryCredentialStore();
    await credentials.write('api-key', 'demo-value');
    expect(await credentials.read('api-key'), 'demo-value');
  });
}
