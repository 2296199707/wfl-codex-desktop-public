import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:path/path.dart' as p;
import 'package:syncvault/src/accounts/controllers/folder_controller.dart'
    hide ListView;
import 'package:syncvault/src/common/components/circular_progress_widget.dart';
import 'package:syncvault/src/home/models/drive_provider_model.dart';

class PickFolderSheet extends HookConsumerWidget {
  const PickFolderSheet({
    super.key,
    required this.providerModel,
    required this.folderNameController,
    required this.parentPathController,
  });

  final DriveProviderModel providerModel;
  final TextEditingController folderNameController;
  final TextEditingController parentPathController;

  String normalizeRemotePath(String value) {
    final segments = value
        .replaceAll('\\', '/')
        .split('/')
        .where((segment) => segment.trim().isNotEmpty)
        .map((segment) => segment.trim())
        .toList();
    return segments.join('/');
  }

  String pathForEntry(String currentPath, String name) {
    final joined = p.join(currentPath, name);
    final normalized = normalizeRemotePath(joined);
    return normalized.isEmpty ? '/' : '/$normalized';
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final currentPath = useState('/');
    final files = ref.watch(listViewProvider(providerModel, currentPath.value));

    void selectDirectory(String path) {
      final selected = normalizeRemotePath(path);
      if (selected.isEmpty) return;
      parentPathController.text = selected;
      if (folderNameController.text.trim().isEmpty) {
        folderNameController.text = 'mobile-sync';
      }
      Navigator.of(context).pop();
    }

    return switch (files) {
      AsyncData(:final value) => ListView(
        padding: EdgeInsets.all(8),
        children: [
          Row(
            children: [
              Expanded(
                child: IconButton(
                  icon: Icon(Icons.arrow_back),
                  onPressed: () async {
                    if (currentPath.value == '/') {
                      return;
                    }

                    final parent = p.dirname(currentPath.value);
                    currentPath.value = parent == '.' ? '/' : parent;
                  },
                ),
              ),
              Expanded(
                child: IconButton(
                  icon: Icon(Icons.home),
                  onPressed: () async {
                    if (currentPath.value == '/') {
                      return;
                    }

                    currentPath.value = '/';
                  },
                ),
              ),
              Expanded(
                child: IconButton(
                  icon: Icon(Icons.check),
                  tooltip: '选择当前文件夹作为同步父目录',
                  onPressed: currentPath.value == '/'
                      ? null
                      : () => selectDirectory(currentPath.value),
                ),
              ),
            ],
          ),
          ListTile(
            leading: Icon(Icons.location_on_sharp),
            title: Text(currentPath.value),
          ),
          ...value.map(
            (file) => ListTile(
              leading: Icon(
                file.isDirectory ? Icons.folder : Icons.file_copy_rounded,
              ),
              title: Text(file.name),
              trailing: file.isDirectory
                  ? IconButton.outlined(
                      tooltip: '选择此文件夹作为同步父目录',
                      onPressed: () => selectDirectory(
                        pathForEntry(currentPath.value, file.name),
                      ),
                      icon: Icon(Icons.check),
                    )
                  : null,
              onTap: file.isDirectory
                  ? () async {
                      currentPath.value = pathForEntry(
                        currentPath.value,
                        file.name,
                      );
                    }
                  : null,
            ),
          ),
        ],
      ),
      AsyncLoading() => CircularProgressWidget(size: 200),
      AsyncError(:final error) => Text(error.toString()),
    };
  }
}
