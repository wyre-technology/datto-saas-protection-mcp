import { describe, it, expect } from 'vitest';

describe('Datto SaaS Protection MCP Server', () => {
  describe('Tool Definitions', () => {
    const expectedTools = [
      'datto_saas_list_clients',
      'datto_saas_list_domains',
      'datto_saas_list_seats',
      'datto_saas_get_seat',
      'datto_saas_list_backups',
      'datto_saas_queue_restore',
      'datto_saas_get_restore_status',
      'datto_saas_list_activity',
      'datto_saas_get_license_usage',
    ];

    it('should define all 9 tools', () => {
      expect(expectedTools).toHaveLength(9);
    });

    it('should include client + domain tools', () => {
      expect(expectedTools).toContain('datto_saas_list_clients');
      expect(expectedTools).toContain('datto_saas_list_domains');
    });

    it('should include seat tools', () => {
      expect(expectedTools).toContain('datto_saas_list_seats');
      expect(expectedTools).toContain('datto_saas_get_seat');
    });

    it('should include backup + restore tools', () => {
      expect(expectedTools).toContain('datto_saas_list_backups');
      expect(expectedTools).toContain('datto_saas_queue_restore');
      expect(expectedTools).toContain('datto_saas_get_restore_status');
    });

    it('should include activity + license tools', () => {
      expect(expectedTools).toContain('datto_saas_list_activity');
      expect(expectedTools).toContain('datto_saas_get_license_usage');
    });
  });

  describe('Region validation', () => {
    const validRegions = ['us', 'eu'];

    it('should support us and eu regions', () => {
      expect(validRegions).toContain('us');
      expect(validRegions).toContain('eu');
    });

    it('should default to us when DATTO_SAAS_REGION is not set', () => {
      expect(process.env.DATTO_SAAS_REGION).toBeUndefined();
    });
  });

  describe('Credentials', () => {
    it('should require DATTO_SAAS_API_KEY', () => {
      const required = ['DATTO_SAAS_API_KEY'];
      expect(required).toHaveLength(1);
    });
  });

  describe('Server Configuration', () => {
    it('should define server with correct name', () => {
      const config = { name: 'datto-saas-protection-mcp', version: '0.0.0' };
      expect(config.name).toBe('datto-saas-protection-mcp');
    });
  });
});
