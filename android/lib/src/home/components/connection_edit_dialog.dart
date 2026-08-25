import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:syncvault/extensions.dart';
import 'package:syncvault/src/home/controllers/connection_controller.dart';
import 'package:syncvault/src/home/models/connection_model.dart';
import 'package:syncvault/src/localization/generated/i18n/app_localizations.dart';

class ConnectionEditDialogWidget extends StatefulHookConsumerWidget {
  const ConnectionEditDialogWidget({super.key, required this.model});

  final ConnectionModel model;

  @override
  ConsumerState<ConnectionEditDialogWidget> createState() =>
      _ConnectionEditDialogWidgetState();
}

class _ConnectionEditDialogWidgetState
    extends ConsumerState<ConnectionEditDialogWidget> {
  late final TextEditingController _titleController;

  @override
  void initState() {
    super.initState();
    _titleController = TextEditingController(text: widget.model.title);
  }

  @override
  void dispose() {
    _titleController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final selectedDirection = useState<Set<SyncDirection>>({
      widget.model.direction,
    });

    final connectionNotifier = ref.read(connectionProvider.notifier);

    return SimpleDialog(
      title: Text(l10n.edit),
      contentPadding: EdgeInsetsGeometry.all(24),
      children: [
        TextField(
          controller: _titleController,
          decoration: InputDecoration(
            border: OutlineInputBorder(),
            hintText: l10n.connectionTitleHint,
          ),
        ),
        const SizedBox(height: 16),
        SegmentedButton<SyncDirection>(
          showSelectedIcon: false,
          segments: SyncDirection.values
              .map(
                (dir) => ButtonSegment(
                  value: dir,
                  label: Text(switch (dir) {
                    SyncDirection.upload => l10n.upload,
                    SyncDirection.download => l10n.download,
                    SyncDirection.bidirectional => l10n.bidirectional,
                  }),
                  icon: Icon(switch (dir) {
                    SyncDirection.bidirectional => Icons.sync,
                    SyncDirection.upload => Icons.upload,
                    SyncDirection.download => Icons.download,
                  }),
                ),
              )
              .toList(),
          selected: selectedDirection.value,
          onSelectionChanged: (val) {
            selectedDirection.value = val;
          },
        ),
        const SizedBox(height: 24),
        ElevatedButton(
          child: Text(l10n.submit),
          onPressed: () async {
            if (_titleController.text.isNotEmpty) {
              await connectionNotifier.edit(
                oldConnection: widget.model,
                newConnection: widget.model.copyWith(
                  title: _titleController.text,
                  direction: selectedDirection.value.first,
                ),
              );

              // TODO: Show this only on no error
              if (context.mounted) {
                context.showSuccessSnackBar(content: l10n.connectionCreated);
                Navigator.of(context).pop();
              }
            }
          },
        ),
      ],
    );
  }
}
