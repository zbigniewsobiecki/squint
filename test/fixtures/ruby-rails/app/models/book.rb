class Book < ApplicationRecord
  belongs_to :author
  has_many :order_items, dependent: :restrict_with_error
end
