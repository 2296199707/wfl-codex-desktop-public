import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:fpdart/fpdart.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:syncvault/extensions.dart';
import 'package:syncvault/errors.dart';
import 'package:syncvault/src/accounts/components/pick_folder_sheet.dart';
import 'package:syncvault/src/common/components/circular_progress_widget.dart';
import 'package:syncvault/src/accounts/controllers/folder_controller.dart'
    hide ListView;
import 'package:syncvault/src/home/models/drive_provider.dart';
import 'package:syncvault/src/home/models/drive_provider_backend.dart';
import 'package:syncvault/src/home/models/drive_provider_model.dart';
import 'package:syncvault/src/localization/generated/i18n/app_localizations.dart';

class NewFolderDialogWidget extends StatefulHookConsumerWidget {
  const NewFolderDialogWidget({super.key, required this.providerModel});

  final DriveProviderModel providerModel;

  @override
  ConsumerState<NewFolderDialogWidget> createState() =>
      _NewFolderDialogWidgetState();
}

class _NewFolderDialogWidgetState extends ConsumerState<NewFolderDialogWidget> {
  late final TextEditingController _folderNameController;
  late final TextEditingController _parentPathController;

  bool get isWflCodexDrive => switch (widget.providerModel) {
    RemoteProviderModel(:final provider) when provider is NextCloudProvider =>
      true,
    _ => false,
  };

  @override
  void initState() {
    super.initState();
    _folderNameController = TextEditingController(
      text: isWflCodexDrive ? 'mobile-sync' : '',
    );
    _parentPathController = TextEditingController();
  }

  @override
  void dispose() {
    _folderNameController.dispose();
    _parentPathController.dispose();
    super.dispose();
  }

  bool validateControllers(List<TextEditingController> controllers) {
    return controllers.all((val) => val.text.isNotEmpty);
  }

  bool validateSelectedFolder(Option<String> path) {
    return path.isSome();
  }

  bool validateRemoteParentPath() {
    final value = _parentPathController.text.trim();
    if (value.isEmpty) return false;
    // WebDAV exposes projects at /dav/<project> and deliberately rejects
    // writes directly below /dav. The picker supplies a project path here.
    if (isWflCodexDrive && value == '/') return false;
    return true;
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final selectedFolder = useState<Option<String>>(const None());
    final createFolderController = ref.watch(createFolderControllerProvider);

    ref.listen<AsyncValue>(createFolderControllerProvider, (prev, state) {
      if (!state.isLoading && state.hasError) {
        context.showErrorSnackBar(
          GeneralError(
            'Failed to create folder',
            state.error!,
            state.stackTrace,
          ).logError().message,
        );
      }
    });

    return SimpleDialog(
      title: Text(l10n.folderRegisterTitle),
      contentPadding: const EdgeInsets.all(24),
      children: [
        TextField(
          controller: _folderNameController,
          decoration: InputDecoration(
            border: OutlineInputBorder(),
            labelText: l10n.folderTitleLabel,
          ),
        ),
        const SizedBox(height: 16),
        switch (widget.providerModel) {
          LocalProviderModel() => Row(
            mainAxisAlignment: MainAxisAlignment.start,
            children: [
              Expanded(
                child: Tooltip(
                  message:
                      selectedFolder.value.toNullable() ??
                      l10n.selectLocalFolder,
                  child: Text(
                    selectedFolder.value.toNullable() ?? l10n.selectLocalFolder,
                    style: Theme.of(context).textTheme.titleMedium,
                    textAlign: TextAlign.left,
                    overflow: TextOverflow.ellipsis,
                    maxLines: 1,
                  ),
                ),
              ),
              IconButton(
                icon: const Icon(Icons.folder),
                tooltip: l10n.selectLocalFolder,
                onPressed: () async {
                  final result = await FilePicker.getDirectoryPath();
                  selectedFolder.value = Option.fromNullable(result);
                },
              ),
            ],
          ),
          RemoteProviderModel(:final backend) => (switch (backend) {
            OAuth2() || UserPassword() || Webdav() => TextField(
              controller: _parentPathController,
              decoration: InputDecoration(
                border: OutlineInputBorder(),
                labelText: l10n.remoteParentPathLabel,
                hintText: isWflCodexDrive ? '/工程名' : null,
                helperText: isWflCodexDrive
                    ? l10n.remoteParentPathHelper
                    : null,
              ),
            ),
            _ => SizedBox(),
          }),
        },
        const SizedBox(height: 16),
        switch (widget.providerModel) {
          RemoteProviderModel(:final backend)
              when backend is OAuth2 ||
                  backend is UserPassword ||
                  backend is Webdav =>
            ElevatedButton(
              onPressed: () {
                showModalBottomSheet(
                  context: context,
                  builder: (ctx) {
                    return BottomSheet(
                      constraints: BoxConstraints(
                        minHeight: MediaQuery.of(context).size.height / 1.5,
                        maxHeight: MediaQuery.of(context).size.height / 1.5,
                      ),
                      onClosing: () {},
                      builder: (ctx) {
                        return PickFolderSheet(
                          providerModel: widget.providerModel,
                          folderNameController: _folderNameController,
                          parentPathController: _parentPathController,
                        );
                      },
                    );
                  },
                );
              },
              child: Text(l10n.selectFolder),
            ),
          _ => SizedBox(),
        },
        const SizedBox(height: 32),
        ElevatedButton(
          onPressed: () async {
            if (!createFolderController.isLoading) {
              final valid = switch (widget.providerModel) {
                RemoteProviderModel(:final backend) => switch (backend) {
                  OAuth2() || UserPassword() || Webdav() =>
                    validateControllers([_folderNameController]) &&
                        validateRemoteParentPath(),
                  _ => validateControllers([_folderNameController]),
                },
                LocalProviderModel() =>
                  validateControllers([_folderNameController]) &&
                      validateSelectedFolder(selectedFolder.value),
              };

              if (valid) {
                await ref
                    .read(createFolderControllerProvider.notifier)
                    .createFolder(
                      folderName: _folderNameController.text,
                      parentPath: switch (widget.providerModel) {
                        RemoteProviderModel(:final backend) =>
                          switch (backend) {
                            OAuth2() ||
                            UserPassword() ||
                            Webdav() => some(_parentPathController.text.trim()),
                            _ => none(),
                          },
                        LocalProviderModel() => selectedFolder.value,
                      },
                      model: widget.providerModel,
                    );

                if (context.mounted && !createFolderController.isLoading) {
                  Navigator.of(context).pop();
                }
              }
            } else {
              context.showErrorSnackBar(l10n.invalidFields);
            }
          },
          child: createFolderController.isLoading
              ? const SizedBox.square(
                  dimension: 20.0,
                  child: CircularProgressWidget(size: 300),
                )
              : Text(l10n.submit),
        ),
      ],
    );
  }
}
