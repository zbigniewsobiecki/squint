class ApplicationRecord < ActiveRecord::Base
  self.abstract_class = true

  def self.recent(limit = 10)
    order(created_at: :desc).limit(limit)
  end
end
