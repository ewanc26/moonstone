##############################################################################
#  moonstone — NixOS module
#
#  Drop-in replacement for modules/server/pds.nix in nix-config.
#  Assumes the same overall architecture:
#
#    moonstone PDS (127.0.0.1:cfg.pds.port)
#      ↑ reverse proxy
#    Caddy (cfg.pds.caddyPort)
#      ↑ Cloudflare tunnel
#
#  Secrets (sops-encrypted, age backend) — same file as before:
#    secrets/pds.env  (dotenv format):
#      PDS_JWT_SECRET
#      PDS_ADMIN_PASSWORD
#      PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX
#
#  Usage in nix-config flake.nix:
#    inputs.moonstone.url = "github:ewanc26/moonstone";
#    ...
#    imports = [ moonstone.nixosModules.moonstone ];
##############################################################################
{
  config,
  lib,
  pkgs,
  pkgs-monorepo,
  moonstone,        # flake input — set via specialArgs
  ...
}:
let
  cfg = config.myConfig;
  pds = cfg.pds;
  pdsPort = toString pds.port;
  caddyPort = toString pds.caddyPort;

  # Build moonstone server from its own flake.
  moonstoneServer = moonstone.packages.${pkgs.stdenv.hostPlatform.system}.server;

  # Landing page from pkgs-monorepo (unchanged).
  landingPage = pkgs-monorepo.packages.${pkgs.stdenv.hostPlatform.system}.pds-landing;

  # Age-assurance stubs (UK Online Safety Act).
  ageAssuranceBlocks = ''
    handle /xrpc/app.bsky.unspecced.getAgeAssuranceState {
      header Content-Type "application/json"
      header Access-Control-Allow-Headers "authorization,dpop,atproto-accept-labelers,atproto-proxy"
      header Access-Control-Allow-Origin "*"
      respond `{"lastInitiatedAt":"2025-07-14T14:22:43.912Z","status":"assured"}` 200
    }
    handle /xrpc/app.bsky.ageassurance.getConfig {
      header Content-Type "application/json"
      header Access-Control-Allow-Headers "authorization,dpop,atproto-accept-labelers,atproto-proxy"
      header Access-Control-Allow-Origin "*"
      respond `{"regions":[]}` 200
    }
    handle /xrpc/app.bsky.ageassurance.getState {
      header Content-Type "application/json"
      header Access-Control-Allow-Headers "authorization,dpop,atproto-accept-labelers,atproto-proxy"
      header Access-Control-Allow-Origin "*"
      respond `{"state":{"lastInitiatedAt":"2025-07-14T14:22:43.912Z","status":"assured","access":"full"},"metadata":{"accountCreatedAt":"2022-11-17T00:35:16.391Z"}}` 200
    }
  '';
in
lib.mkIf cfg.services.pds.enable {

  sops.secrets."pds.env" = {
    sopsFile = ../../secrets/pds.env;
    format = "dotenv";
    owner = "moonstone";
    group = "moonstone";
    mode = "0400";
  };

  users.users.moonstone = {
    isSystemUser = true;
    group = "moonstone";
    home = "/srv/bluesky-pds";
    createHome = false;
  };
  users.groups.moonstone = {};

  systemd.services.moonstone-pds = {
    description = "moonstone ATProto PDS";
    after = [ "network.target" "srv.mount" ];
    wants = [ "srv.mount" ];
    wantedBy = [ "multi-user.target" ];

    environment = {
      PDS_HOSTNAME = pds.hostname;
      PDS_PORT = pdsPort;
      PDS_DATA_DIRECTORY = "/srv/bluesky-pds";
      PDS_SERVICE_HANDLE_DOMAINS = lib.concatStringsSep "," pds.serviceHandleDomains;
      PDS_CRAWLERS = lib.concatStringsSep "," pds.crawlers;
    } // lib.optionalAttrs (pds ? adminEmail) {
      PDS_ADMIN_EMAIL = pds.adminEmail;
    };

    serviceConfig = {
      Type = "simple";
      User = "moonstone";
      Group = "moonstone";
      EnvironmentFile = config.sops.secrets."pds.env".path;
      ExecStart = "${moonstoneServer}/bin/moonstone-pds";
      Restart = "always";
      RestartSec = cfg.server.servicePolicy.restartSec;
      ReadWritePaths = [ "/srv/bluesky-pds" ];

      # Hardening
      NoNewPrivileges = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      PrivateTmp = true;
    };

    unitConfig = {
      StartLimitIntervalSec = cfg.server.servicePolicy.startLimitIntervalSec;
      StartLimitBurst = cfg.server.servicePolicy.startLimitBurst;
    };
  };

  services.caddy.virtualHosts."http://${pds.hostname}:${caddyPort}" = {
    extraConfig = ''
      ${ageAssuranceBlocks}

      root * ${landingPage}

      redir /index.html / permanent

      @pds not file {
        try_files {path} {path}/index.html
      }
      handle @pds {
        reverse_proxy http://127.0.0.1:${pdsPort}
      }

      file_server
    '';
  };
}
