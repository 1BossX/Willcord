export const caFileName = "willcord-ca.pem";

/** The fingerprint on this page arrives over the same connection as ca.pem, so it is only a value to compare, not a source to trust. */
export const fingerprintCheckNote =
  "这个指纹与 ca.pem 来自同一次连接，页面本身不能证明它可信。请先从已信任或独立的渠道（例如管理员另行告知的值）取得指纹，再与上面显示的值逐位核对；不一致请勿信任。";

export const trustLinkCommand =
  "willcord trust-ca 'https://<主节点地址>#sha256=<已从独立渠道核对的指纹>'";

export type TrustGuide = {
  id: "macos" | "linux" | "windows" | "firefox";
  title: string;
  steps: string[];
  commands: { label: string; command: string }[];
};

/** Per-system steps for trusting the main node's root certificate, once the browser has downloaded it. */
export function trustGuides(fileName = caFileName): TrustGuide[] {
  return [
    {
      id: "macos",
      title: "macOS",
      steps: [
        "双击下载的 ca.pem，在“钥匙串访问”中加入“系统”钥匙串。",
        "找到 Willcord 证书，双击打开，展开“信任”，把“使用此证书时”设为“始终信任”。",
      ],
      commands: [
        {
          label: "终端",
          command: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/Downloads/${fileName}`,
        },
      ],
    },
    {
      id: "linux",
      title: "Linux",
      steps: ["按发行版选择命令；完成后重启浏览器。"],
      commands: [
        {
          label: "Debian / Ubuntu",
          command: `sudo cp ~/Downloads/${fileName} /usr/local/share/ca-certificates/willcord-ca.crt && sudo update-ca-certificates`,
        },
        {
          label: "Fedora / RHEL",
          command: `sudo cp ~/Downloads/${fileName} /etc/pki/ca-trust/source/anchors/willcord-ca.crt && sudo update-ca-trust`,
        },
      ],
    },
    {
      id: "windows",
      title: "Windows",
      steps: [
        "双击下载的 ca.pem，点击“安装证书”。",
        "存储位置选“本地计算机”，再选“将所有的证书放入下列存储”，选择“受信任的根证书颁发机构”。",
      ],
      commands: [
        {
          label: "管理员 PowerShell",
          command: `certutil -addstore -f Root "$env:USERPROFILE\\Downloads\\${fileName}"`,
        },
      ],
    },
    {
      id: "firefox",
      title: "Firefox",
      steps: [
        "Firefox 使用自己的证书库，上面的系统信任对它不生效，需要单独导入。",
        "打开 设置 → 隐私与安全 → 证书 → 查看证书 → 证书颁发机构 → 导入，选择 ca.pem。",
        "勾选“信任此 CA 以标识网站”并确定，然后刷新控制台。",
      ],
      commands: [],
    },
  ];
}
