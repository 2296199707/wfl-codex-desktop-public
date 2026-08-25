// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for Chinese (`zh`).
class AppLocalizationsZh extends AppLocalizations {
  AppLocalizationsZh([String locale = 'zh']) : super(locale);

  @override
  String get appTitle => 'WFL Codex 网盘';

  @override
  String get homeTitle => '同步';

  @override
  String get accountsTitle => '账户';

  @override
  String get settingsTitle => '设置';

  @override
  String get workflowsTitle => '工作流';

  @override
  String get loginTitle => '登录 WFL Codex 网盘';

  @override
  String get loginSubtitle => '连接手机与服务器，开始同步文件。';

  @override
  String get serverUrlLabel => '服务器地址';

  @override
  String get serverUrlHint => 'https://cloud.example.com';

  @override
  String get serverUrlHelper => '将自动使用服务器的 /dav 网盘接口';

  @override
  String get usernameLabel => '用户名';

  @override
  String get passwordLabel => '密码';

  @override
  String get loginButton => '登录';

  @override
  String get loggingIn => '正在登录…';

  @override
  String get invalidServerUrl => '请输入有效的 http 或 https 服务器地址';

  @override
  String get requiredField => '请填写此项';

  @override
  String get loginFailed => '登录失败，请检查服务器地址、用户名和密码';

  @override
  String get loginSuccess => '登录成功';

  @override
  String get startupLoading => '正在准备网盘…';

  @override
  String get next => '下一步';

  @override
  String get done => '完成';

  @override
  String get back => '返回';

  @override
  String get welcomeTitle => 'WFL Codex 网盘';

  @override
  String get welcomeBody => '欢迎使用。完成下面的准备工作后，就可以登录并同步文件。';

  @override
  String get folderPermissionsTitle => '文件权限';

  @override
  String get folderPermissionsBody => '应用需要访问文件，才能正常同步手机文件夹。';

  @override
  String get grantPermissions => '授予权限';

  @override
  String get batteryPermissionsTitle => '电池权限';

  @override
  String get batteryPermissionsBody => '请关闭电池优化，保证后台同步正常运行。';

  @override
  String get notificationPermissionsTitle => '通知权限';

  @override
  String get notificationPermissionsBody => '允许通知，以便显示同步进度和结果。';

  @override
  String get downloadRcloneTitle => '准备同步组件';

  @override
  String get downloadRcloneBody => '应用使用开源 RClone 作为文件同步引擎。';

  @override
  String get downloadRclone => '下载 RClone';

  @override
  String get downloadComplete => '已完成';

  @override
  String downloadProgress(Object percent) {
    return '进度 $percent%';
  }

  @override
  String get accountTooltip => '账户';

  @override
  String get settingsTooltip => '设置';

  @override
  String get workflowsTooltip => '工作流';

  @override
  String get createConnectionTooltip => '新建同步任务';

  @override
  String get useRclone => '使用 RClone';

  @override
  String get registerRemoteTitle => '添加网盘账户';

  @override
  String get remoteNameLabel => '账户名称';

  @override
  String get wflCodexProvider => 'WFL Codex';

  @override
  String get webdavUrlLabel => '网盘地址（https://服务器/dav）';

  @override
  String get wflUsernameLabel => 'WFL Codex 用户名';

  @override
  String get submit => '保存';

  @override
  String get accountAddFolder => '添加文件夹';

  @override
  String get accountInfo => '空间信息';

  @override
  String get accountDelete => '删除账户';

  @override
  String get localTitle => '手机本地';

  @override
  String get remoteAvailable => '已连接';

  @override
  String get remoteUnavailable => '连接失败';

  @override
  String get remoteChecking => '检查中';

  @override
  String get folderRegisterTitle => '添加文件夹';

  @override
  String get folderTitleLabel => '文件夹名称';

  @override
  String get selectLocalFolder => '选择手机文件夹';

  @override
  String get selectFolder => '选择文件夹';

  @override
  String get remoteParentPathLabel => '网盘父文件夹';

  @override
  String get remoteParentPathHelper => '请先选择当前账号的工程文件夹，文件只会保存在你的工程内。';

  @override
  String get connectionTitle => '新建同步任务';

  @override
  String get connectionTitleHint => '任务名称';

  @override
  String get firstFolder => '选择源文件夹';

  @override
  String get secondFolder => '选择目标文件夹';

  @override
  String get upload => '上传';

  @override
  String get download => '下载';

  @override
  String get bidirectional => '双向同步';

  @override
  String get connectionCreated => '同步任务已创建';

  @override
  String get missingConnectionFields => '请填写任务名称并选择两个文件夹';

  @override
  String get sync => '同步';

  @override
  String get edit => '编辑';

  @override
  String get delete => '删除';

  @override
  String get cancel => '取消';

  @override
  String get autoSync => '自动同步';

  @override
  String get deleteOnSync => '同步时删除';

  @override
  String get offlineBanner => '网络连接受限';

  @override
  String get needTwoFolders => '请先创建至少一个手机文件夹和一个网盘文件夹';

  @override
  String get syncFailed => '同步失败';

  @override
  String get connectionNotReady => '同步任务尚未准备好';

  @override
  String get showPassword => '显示密码';

  @override
  String get hidePassword => '隐藏密码';

  @override
  String get github => 'RClone GitHub';

  @override
  String get invalidFields => '请检查并填写完整信息';
}
