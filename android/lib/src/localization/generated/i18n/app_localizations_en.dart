// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for English (`en`).
class AppLocalizationsEn extends AppLocalizations {
  AppLocalizationsEn([String locale = 'en']) : super(locale);

  @override
  String get appTitle => 'WFL Codex Drive';

  @override
  String get homeTitle => 'Sync';

  @override
  String get accountsTitle => 'Accounts';

  @override
  String get settingsTitle => 'Settings';

  @override
  String get workflowsTitle => 'Workflows';

  @override
  String get loginTitle => 'Sign in to WFL Codex Drive';

  @override
  String get loginSubtitle =>
      'Connect this phone to your server and start syncing files.';

  @override
  String get serverUrlLabel => 'Server address';

  @override
  String get serverUrlHint => 'https://cloud.example.com';

  @override
  String get serverUrlHelper =>
      'The app will use the server\'s /dav drive endpoint.';

  @override
  String get usernameLabel => 'Username';

  @override
  String get passwordLabel => 'Password';

  @override
  String get loginButton => 'Sign in';

  @override
  String get loggingIn => 'Signing in…';

  @override
  String get invalidServerUrl => 'Enter a valid http or https server address.';

  @override
  String get requiredField => 'This field is required.';

  @override
  String get loginFailed =>
      'Sign-in failed. Check the server address and credentials.';

  @override
  String get loginSuccess => 'Signed in successfully.';

  @override
  String get startupLoading => 'Preparing your drive…';

  @override
  String get next => 'Next';

  @override
  String get done => 'Done';

  @override
  String get back => 'Back';

  @override
  String get welcomeTitle => 'WFL Codex Drive';

  @override
  String get welcomeBody =>
      'Welcome. Complete these preparation steps before signing in and syncing files.';

  @override
  String get folderPermissionsTitle => 'File permissions';

  @override
  String get folderPermissionsBody =>
      'The app needs file access to sync folders on your phone.';

  @override
  String get grantPermissions => 'Grant permission';

  @override
  String get batteryPermissionsTitle => 'Battery permission';

  @override
  String get batteryPermissionsBody =>
      'Disable battery optimization so background sync can run.';

  @override
  String get notificationPermissionsTitle => 'Notification permission';

  @override
  String get notificationPermissionsBody =>
      'Allow notifications to show sync progress and results.';

  @override
  String get downloadRcloneTitle => 'Prepare sync engine';

  @override
  String get downloadRcloneBody =>
      'The app uses the open-source RClone sync engine.';

  @override
  String get downloadRclone => 'Download RClone';

  @override
  String get downloadComplete => 'Complete';

  @override
  String downloadProgress(Object percent) {
    return 'Progress $percent%';
  }

  @override
  String get accountTooltip => 'Accounts';

  @override
  String get settingsTooltip => 'Settings';

  @override
  String get workflowsTooltip => 'Workflows';

  @override
  String get createConnectionTooltip => 'New sync task';

  @override
  String get useRclone => 'Use RClone';

  @override
  String get registerRemoteTitle => 'Add drive account';

  @override
  String get remoteNameLabel => 'Account name';

  @override
  String get wflCodexProvider => 'WFL Codex';

  @override
  String get webdavUrlLabel => 'Drive URL (https://server/dav)';

  @override
  String get wflUsernameLabel => 'WFL Codex username';

  @override
  String get submit => 'Save';

  @override
  String get accountAddFolder => 'Add folder';

  @override
  String get accountInfo => 'Storage info';

  @override
  String get accountDelete => 'Delete account';

  @override
  String get localTitle => 'Phone storage';

  @override
  String get remoteAvailable => 'Connected';

  @override
  String get remoteUnavailable => 'Connection failed';

  @override
  String get remoteChecking => 'Checking';

  @override
  String get folderRegisterTitle => 'Add folder';

  @override
  String get folderTitleLabel => 'Folder name';

  @override
  String get selectLocalFolder => 'Select phone folder';

  @override
  String get selectFolder => 'Select folder';

  @override
  String get remoteParentPathLabel => 'Remote parent folder';

  @override
  String get remoteParentPathHelper =>
      'Choose a project folder first. Files stay inside your account\'s project.';

  @override
  String get connectionTitle => 'New sync task';

  @override
  String get connectionTitleHint => 'Task name';

  @override
  String get firstFolder => 'Select source folder';

  @override
  String get secondFolder => 'Select destination folder';

  @override
  String get upload => 'Upload';

  @override
  String get download => 'Download';

  @override
  String get bidirectional => 'Two-way sync';

  @override
  String get connectionCreated => 'Sync task created';

  @override
  String get missingConnectionFields =>
      'Enter a task name and select two folders.';

  @override
  String get sync => 'Sync';

  @override
  String get edit => 'Edit';

  @override
  String get delete => 'Delete';

  @override
  String get cancel => 'Cancel';

  @override
  String get autoSync => 'Auto sync';

  @override
  String get deleteOnSync => 'Delete on sync';

  @override
  String get offlineBanner => 'Limited network connectivity';

  @override
  String get needTwoFolders =>
      'Create at least one phone folder and one drive folder first.';

  @override
  String get syncFailed => 'Sync failed';

  @override
  String get connectionNotReady => 'The sync task is not ready';

  @override
  String get showPassword => 'Show password';

  @override
  String get hidePassword => 'Hide password';

  @override
  String get github => 'RClone GitHub';

  @override
  String get invalidFields => 'Please check and complete all fields.';
}
