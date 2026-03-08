class User < ApplicationRecord
  validates :email, presence: true, uniqueness: true
  validates :name, presence: true

  has_many :posts

  def display_name
    "#{name} (#{email})"
  end
end