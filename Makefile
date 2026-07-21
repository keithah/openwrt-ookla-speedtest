include $(TOPDIR)/rules.mk

PKG_NAME:=ookla-speedtest-cli
PKG_VERSION:=1.2.0
PKG_RELEASE:=1

OOKLA_ARCH:=
OOKLA_HASH_aarch64:=3953d231da3783e2bf8904b6dd72767c5c6e533e163d3742fd0437affa431bd3
OOKLA_HASH_armhf:=e45fcdebbd8a185553535533dd032d6b10bc8c64eee4139b1147b9c09835d08d
OOKLA_HASH_armel:=629a455a2879224bd0dbd4b36d8c721dda540717937e4660b4d2c966029466bf

ifeq ($(ARCH),aarch64)
  OOKLA_ARCH:=aarch64
else ifeq ($(ARCH),arm)
  ifeq ($(CONFIG_SOFT_FLOAT),y)
    OOKLA_ARCH:=armel
  else
    OOKLA_ARCH:=armhf
  endif
endif

PKG_SOURCE:=ookla-speedtest-$(PKG_VERSION)-linux-$(OOKLA_ARCH).tgz
PKG_SOURCE_URL:=https://install.speedtest.net/app/cli/
PKG_HASH:=$(OOKLA_HASH_$(OOKLA_ARCH))
PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)-$(OOKLA_ARCH)
PKG_LICENSE:=Proprietary
PKG_MAINTAINER:=Keith Herrington <keith@hadm.net>

include $(INCLUDE_DIR)/package.mk

define Package/ookla-speedtest-cli
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=Ookla Speedtest CLI
  DEPENDS:=@(aarch64||arm)
endef

define Package/ookla-speedtest-cli/description
  Command-line interface for testing internet bandwidth using Speedtest by Ookla.
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	$(TAR) -xzf $(DL_DIR)/$(PKG_SOURCE) -C $(PKG_BUILD_DIR)
endef

define Build/Compile
endef

define Package/ookla-speedtest-cli/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/speedtest $(1)/usr/bin/speedtest
endef

$(eval $(call BuildPackage,ookla-speedtest-cli))
