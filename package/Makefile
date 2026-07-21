include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-ookla-speedtest-web
PKG_VERSION:=1.1.1
PKG_RELEASE:=1
PKGARCH:=all

include $(INCLUDE_DIR)/package.mk

define Package/ookla-speedtest-webd
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Ookla Speedtest web RPC helper
  DEPENDS:=+ookla-speedtest-cli
endef

define Package/luci-app-ookla-speedtest-web
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=LuCI web interface for Ookla Speedtest
  DEPENDS:=+ookla-speedtest-webd +luci-base +rpcd
endef

define Package/gl-app-ookla-speedtest-web
  SECTION:=luci
  CATEGORY:=LuCI
  TITLE:=GL.iNet Ookla Speedtest application
  DEPENDS:=+luci-app-ookla-speedtest-web
endef

define Build/Compile
endef

define Package/ookla-speedtest-webd/install
	$(CP) ./ookla-speedtest-webd/etc $(1)/
	$(CP) ./ookla-speedtest-webd/usr $(1)/
	chmod 0755 $(1)/usr/libexec/ookla-speedtest-webd $(1)/etc/init.d/ookla-speedtest-webd $(1)/etc/uci-defaults/99-ookla-speedtest-webd
endef

define Package/luci-app-ookla-speedtest-web/install
	$(CP) ./luci-app-ookla-speedtest-web/usr $(1)/
	$(CP) ./luci-app-ookla-speedtest-web/www $(1)/
	$(CP) ./luci-app-ookla-speedtest-web/etc $(1)/ 2>/dev/null || true
	$(CP) ./shared/ookla-speedtest-web $(1)/www/luci-static/resources/
	chmod 0755 $(1)/usr/libexec/rpcd/ookla-speedtest-web
endef

define Package/gl-app-ookla-speedtest-web/install
	$(CP) ./gl-app-ookla-speedtest-web/usr $(1)/
	$(CP) ./gl-app-ookla-speedtest-web/www $(1)/
	$(CP) ./shared/ookla-speedtest-web $(1)/www/
	chmod 0755 $(1)/usr/lib/oui-httpd/rpc/ookla-speedtest-web
endef

$(eval $(call BuildPackage,ookla-speedtest-webd))
$(eval $(call BuildPackage,luci-app-ookla-speedtest-web))
$(eval $(call BuildPackage,gl-app-ookla-speedtest-web))
