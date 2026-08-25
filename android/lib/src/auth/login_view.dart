import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:syncvault/errors.dart';
import 'package:syncvault/src/accounts/controllers/auth_controller.dart';
import 'package:syncvault/src/accounts/services/rclone.dart';
import 'package:syncvault/src/home/models/drive_provider.dart';
import 'package:syncvault/src/home/models/drive_provider_backend.dart';
import 'package:syncvault/src/home/models/drive_provider_model.dart';
import 'package:syncvault/src/home/views/home_view.dart';
import 'package:syncvault/src/localization/generated/i18n/app_localizations.dart';

class LoginView extends ConsumerStatefulWidget {
  const LoginView({super.key});

  static const routeName = '/login';

  @override
  ConsumerState<LoginView> createState() => _LoginViewState();
}

class _LoginViewState extends ConsumerState<LoginView> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _urlController;
  late final TextEditingController _usernameController;
  late final TextEditingController _passwordController;
  bool _obscurePassword = true;
  bool _isSubmitting = false;

  @override
  void initState() {
    super.initState();
    _urlController = TextEditingController();
    _usernameController = TextEditingController();
    _passwordController = TextEditingController();
  }

  @override
  void dispose() {
    _urlController.dispose();
    _usernameController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  String _webdavUrl() {
    var value = _urlController.text.trim();
    while (value.endsWith('/')) {
      value = value.substring(0, value.length - 1);
    }
    if (!value.endsWith('/dav')) value = '$value/dav';
    return value;
  }

  bool _isValidServerUrl(String value) {
    final uri = Uri.tryParse(value);
    return uri != null &&
        (uri.scheme == 'http' || uri.scheme == 'https') &&
        uri.host.isNotEmpty;
  }

  RemoteProviderModel? _savedAccount() {
    final accounts = ref.read(authProvider).value ?? const [];
    for (final account in accounts) {
      if (account is RemoteProviderModel &&
          account.remoteName == 'WFL Codex' &&
          account.provider is NextCloudProvider) {
        return account;
      }
    }
    return null;
  }

  Future<void> _submit(AppLocalizations l10n) async {
    if (!_formKey.currentState!.validate()) return;

    setState(() => _isSubmitting = true);
    try {
      final url = _webdavUrl();

      // The entry gate can intentionally show this page when an old account
      // is no longer valid. Replace that account before creating the new
      // rclone remote, otherwise authorization fails with "provider already
      // exists" and the stale account remains selected by the app.
      final previousAccount = _savedAccount();
      if (previousAccount != null) {
        await ref.read(authProvider.notifier).signOut(previousAccount);
      }

      await ref
          .read(authControllerProvider.notifier)
          .signIn(
            Webdav(
              url: url,
              user: _usernameController.text.trim(),
              password: _passwordController.text,
            ),
            const DriveProvider.nextCloud(),
            'WFL Codex',
            true,
          );

      final account = _savedAccount();
      if (account == null) {
        throw const GeneralError('WFL Codex account was not saved', null, null);
      }

      final healthy = await RCloneAuthService()
          .isHealthy(model: account)
          .run()
          .then((result) => result.match((_) => false, (value) => value));
      if (!healthy) {
        await ref.read(authProvider.notifier).signOut(account);
        throw const GeneralError(
          'WFL Codex account is unavailable',
          null,
          null,
        );
      }

      if (!mounted) return;
      Navigator.of(context).pushReplacementNamed(HomeView.routeName);
    } catch (error, stackTrace) {
      GeneralError(l10n.loginFailed, error, stackTrace).logError();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(l10n.loginFailed),
          behavior: SnackBarBehavior.floating,
        ),
      );
      // Keep the failed attempt on an explicit login route. This also
      // recovers if the view was reached through a stale /home route.
      Navigator.of(context).pushReplacementNamed(LoginView.routeName);
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 520),
              child: Card(
                elevation: 2,
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Form(
                    key: _formKey,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Icon(
                          Icons.cloud_rounded,
                          size: 64,
                          color: Theme.of(context).colorScheme.primary,
                        ),
                        const SizedBox(height: 16),
                        Text(
                          l10n.loginTitle,
                          textAlign: TextAlign.center,
                          style: Theme.of(context).textTheme.headlineSmall,
                        ),
                        const SizedBox(height: 8),
                        Text(
                          l10n.loginSubtitle,
                          textAlign: TextAlign.center,
                          style: Theme.of(context).textTheme.bodyMedium,
                        ),
                        const SizedBox(height: 28),
                        TextFormField(
                          controller: _urlController,
                          keyboardType: TextInputType.url,
                          textInputAction: TextInputAction.next,
                          autofillHints: const [AutofillHints.url],
                          decoration: InputDecoration(
                            labelText: l10n.serverUrlLabel,
                            hintText: l10n.serverUrlHint,
                            helperText: l10n.serverUrlHelper,
                            prefixIcon: const Icon(Icons.link),
                            border: const OutlineInputBorder(),
                          ),
                          validator: (value) {
                            if (value == null || value.trim().isEmpty) {
                              return l10n.requiredField;
                            }
                            return _isValidServerUrl(_webdavUrl())
                                ? null
                                : l10n.invalidServerUrl;
                          },
                        ),
                        const SizedBox(height: 16),
                        TextFormField(
                          controller: _usernameController,
                          textInputAction: TextInputAction.next,
                          autofillHints: const [AutofillHints.username],
                          decoration: InputDecoration(
                            labelText: l10n.usernameLabel,
                            prefixIcon: const Icon(Icons.person_outline),
                            border: const OutlineInputBorder(),
                          ),
                          validator: (value) =>
                              value == null || value.trim().isEmpty
                              ? l10n.requiredField
                              : null,
                        ),
                        const SizedBox(height: 16),
                        TextFormField(
                          controller: _passwordController,
                          obscureText: _obscurePassword,
                          textInputAction: TextInputAction.done,
                          autofillHints: const [AutofillHints.password],
                          onFieldSubmitted: _isSubmitting
                              ? null
                              : (_) => _submit(l10n),
                          decoration: InputDecoration(
                            labelText: l10n.passwordLabel,
                            prefixIcon: const Icon(Icons.lock_outline),
                            suffixIcon: IconButton(
                              tooltip: _obscurePassword
                                  ? l10n.showPassword
                                  : l10n.hidePassword,
                              onPressed: () => setState(
                                () => _obscurePassword = !_obscurePassword,
                              ),
                              icon: Icon(
                                _obscurePassword
                                    ? Icons.visibility
                                    : Icons.visibility_off,
                              ),
                            ),
                            border: const OutlineInputBorder(),
                          ),
                          validator: (value) => value == null || value.isEmpty
                              ? l10n.requiredField
                              : null,
                        ),
                        const SizedBox(height: 24),
                        FilledButton.icon(
                          onPressed: _isSubmitting ? null : () => _submit(l10n),
                          icon: _isSubmitting
                              ? const SizedBox(
                                  width: 18,
                                  height: 18,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                )
                              : const Icon(Icons.login),
                          label: Text(
                            _isSubmitting ? l10n.loggingIn : l10n.loginButton,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
